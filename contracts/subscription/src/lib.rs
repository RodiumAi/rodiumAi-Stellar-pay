#![no_std]

mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    Address, BytesN, ContractExecutable, Env, contract, contractimpl, panic_with_error, token,
};

use crate::events::{Canceled, Charged, KeeperSet, PausedSet, PlanSet, SubCreated, Upgraded};

pub use crate::types::{ChargeOutcome, Error, Plan, SubStatus, Subscription};

/// Minimum billing interval; matches `subscriptions.interval_seconds >= 86400` (context §7.1).
pub const MIN_INTERVAL_SECS: u64 = 86_400;

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// Runs atomically with deployment, so no one can front-run initialisation
    /// (replaces the separate `init` from context §14.1).
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        merchant: Address,
        keeper: Address,
    ) {
        storage::init_config(&env, &admin, &token, &merchant, &keeper);
    }

    pub fn set_plan(
        env: Env,
        plan_id: u32,
        price: i128,
        interval_secs: u64,
        active: bool,
    ) -> Result<(), Error> {
        storage::admin(&env).require_auth();
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if interval_secs < MIN_INTERVAL_SECS {
            return Err(Error::InvalidInterval);
        }
        storage::set_plan(
            &env,
            plan_id,
            &Plan {
                price,
                interval_secs,
                active,
            },
        );
        PlanSet {
            plan_id,
            price,
            interval_secs,
            active,
        }
        .publish(&env);
        Ok(())
    }

    pub fn subscribe(
        env: Env,
        subscriber: Address,
        plan_id: u32,
        periods: u32,
        live_until_ledger: u32,
    ) -> Result<u64, Error> {
        subscriber.require_auth();
        storage::extend_instance(&env);
        if storage::paused(&env) {
            return Err(Error::Paused);
        }
        let plan = storage::plan(&env, plan_id).ok_or(Error::PlanNotFound)?;
        if !plan.active {
            return Err(Error::PlanInactive);
        }
        if periods == 0 {
            return Err(Error::InvalidPeriods);
        }
        let allowance = plan
            .price
            .checked_mul(i128::from(periods))
            .ok_or(Error::Overflow)?;
        let now = env.ledger().timestamp();
        let next_charge_at = now.checked_add(plan.interval_secs).ok_or(Error::Overflow)?;

        let token = token::Client::new(&env, &storage::token(&env));
        let merchant = storage::merchant(&env);
        token.transfer(&subscriber, &merchant, &plan.price);
        token.approve(
            &subscriber,
            &env.current_contract_address(),
            &allowance,
            &live_until_ledger,
        );

        let sub_id = storage::next_sub_id(&env)?;
        let sub = Subscription {
            subscriber: subscriber.clone(),
            plan_id,
            price: plan.price,
            interval_secs: plan.interval_secs,
            next_charge_at,
            status: SubStatus::Active,
        };
        storage::set_subscription(&env, sub_id, &sub);
        SubCreated {
            sub_id,
            subscriber,
            plan_id,
            price: plan.price,
            next_charge_at,
        }
        .publish(&env);
        Ok(sub_id)
    }

    pub fn charge(env: Env, sub_id: u64) -> Result<ChargeOutcome, Error> {
        storage::keeper(&env).require_auth();
        storage::extend_instance(&env);
        if storage::paused(&env) {
            return Err(Error::Paused);
        }
        let mut sub = storage::subscription(&env, sub_id).ok_or(Error::SubscriptionNotFound)?;
        if sub.status != SubStatus::Active {
            return Err(Error::NotActive);
        }
        let now = env.ledger().timestamp();
        if now < sub.next_charge_at {
            return Err(Error::NotDue);
        }
        let following = sub
            .next_charge_at
            .checked_add(sub.interval_secs)
            .ok_or(Error::Overflow)?;
        // No back-charging: a charge more than one interval late starts a fresh period now.
        sub.next_charge_at = if now >= following {
            now.checked_add(sub.interval_secs).ok_or(Error::Overflow)?
        } else {
            following
        };

        token::Client::new(&env, &storage::token(&env)).transfer_from(
            &env.current_contract_address(),
            &sub.subscriber,
            &storage::merchant(&env),
            &sub.price,
        );
        storage::set_subscription(&env, sub_id, &sub);
        Charged {
            sub_id,
            amount: sub.price,
            next_charge_at: sub.next_charge_at,
        }
        .publish(&env);
        Ok(ChargeOutcome {
            sub_id,
            amount: sub.price,
            next_charge_at: sub.next_charge_at,
        })
    }

    pub fn cancel(env: Env, caller: Address, sub_id: u64) -> Result<(), Error> {
        caller.require_auth();
        storage::extend_instance(&env);
        let mut sub = storage::subscription(&env, sub_id).ok_or(Error::SubscriptionNotFound)?;
        if caller != sub.subscriber && caller != storage::admin(&env) {
            return Err(Error::Unauthorized);
        }
        if sub.status != SubStatus::Active {
            return Err(Error::NotActive);
        }
        sub.status = SubStatus::Canceled;
        storage::set_subscription(&env, sub_id, &sub);
        Canceled { sub_id, by: caller }.publish(&env);
        Ok(())
    }

    pub fn set_paused(env: Env, paused: bool) {
        storage::admin(&env).require_auth();
        storage::set_paused(&env, paused);
        PausedSet { paused }.publish(&env);
    }

    pub fn set_keeper(env: Env, keeper: Address) {
        storage::admin(&env).require_auth();
        storage::set_keeper(&env, &keeper);
        KeeperSet { keeper }.publish(&env);
    }

    pub fn upgrade(env: Env, wasm_hash: BytesN<32>) {
        storage::admin(&env).require_auth();
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(wasm_hash.clone()));
        Upgraded { wasm_hash }.publish(&env);
    }

    pub fn get(env: Env, sub_id: u64) -> Result<Subscription, Error> {
        storage::subscription(&env, sub_id).ok_or(Error::SubscriptionNotFound)
    }

    pub fn plan(env: Env, plan_id: u32) -> Result<Plan, Error> {
        storage::plan(&env, plan_id).ok_or(Error::PlanNotFound)
    }

    pub fn merchant(env: Env) -> Address {
        storage::merchant(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        storage::paused(&env)
    }
}

pub(crate) fn fail(env: &Env, error: Error) -> ! {
    panic_with_error!(env, error)
}
