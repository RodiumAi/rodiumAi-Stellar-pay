#![cfg(test)]
extern crate std;

use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, Event, IntoVal, Val, Vec};

use crate::events::{Canceled, Charged, SubCreated};
use crate::{
    Error, MIN_INTERVAL_SECS, SubStatus, SubscriptionContract, SubscriptionContractClient,
};

const PRICE: i128 = 99_900_000; // 9.99 USDC
const INTERVAL: u64 = 30 * MIN_INTERVAL_SECS;
const PLAN: u32 = 1;
const START: u64 = 1_760_000_000;

struct Setup {
    env: Env,
    contract: Address,
    client: SubscriptionContractClient<'static>,
    token: TokenClient<'static>,
    admin: Address,
    merchant: Address,
    keeper: Address,
    subscriber: Address,
}

fn invoke<'a>(contract: &'a Address, fn_name: &'a str, args: Vec<Val>) -> MockAuthInvoke<'a> {
    MockAuthInvoke {
        contract,
        fn_name,
        args,
        sub_invokes: &[],
    }
}

impl Setup {
    fn new() -> Self {
        let env = Env::default();
        env.ledger().with_mut(|l| {
            l.timestamp = START;
            l.sequence_number = 1_000;
        });
        let admin = Address::generate(&env);
        let merchant = Address::generate(&env);
        let keeper = Address::generate(&env);
        let subscriber = Address::generate(&env);
        let issuer = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(issuer.clone());
        let token_id = sac.address();
        let asset_admin = StellarAssetClient::new(&env, &token_id);
        asset_admin
            .mock_auths(&[MockAuth {
                address: &issuer,
                invoke: &invoke(
                    &token_id,
                    "mint",
                    (&subscriber, 1_000 * PRICE).into_val(&env),
                ),
            }])
            .mint(&subscriber, &(1_000 * PRICE));

        let contract = env.register(
            SubscriptionContract,
            (
                admin.clone(),
                token_id.clone(),
                merchant.clone(),
                keeper.clone(),
            ),
        );
        let client = SubscriptionContractClient::new(&env, &contract);
        let token = TokenClient::new(&env, &token_id);
        let s = Setup {
            env,
            contract,
            client,
            token,
            admin,
            merchant,
            keeper,
            subscriber,
        };
        s.set_plan_as(&s.admin.clone(), PLAN, PRICE, INTERVAL, true)
            .unwrap();
        s
    }

    fn set_plan_as(
        &self,
        who: &Address,
        plan: u32,
        price: i128,
        interval: u64,
        active: bool,
    ) -> Result<(), Error> {
        let args = (plan, price, interval, active).into_val(&self.env);
        self.client
            .mock_auths(&[MockAuth {
                address: who,
                invoke: &invoke(&self.contract, "set_plan", args),
            }])
            .try_set_plan(&plan, &price, &interval, &active)
            .map(|r| r.unwrap())
            .map_err(|e| e.expect("contract error"))
    }

    fn live_until(&self) -> u32 {
        self.env.ledger().sequence() + 100_000
    }

    /// The subscriber signs `subscribe` and both token sub-invocations: one signature, whole tree.
    fn subscribe(&self, periods: u32) -> Result<u64, Error> {
        self.subscribe_with_price(periods, PRICE)
    }

    fn subscribe_with_price(&self, periods: u32, price: i128) -> Result<u64, Error> {
        let env = &self.env;
        let live_until = self.live_until();
        let token_id = self.token.address.clone();
        let allowance = price.saturating_mul(i128::from(periods));
        let sub_invokes = [
            invoke(
                &token_id,
                "transfer",
                (&self.subscriber, &self.merchant, price).into_val(env),
            ),
            invoke(
                &token_id,
                "approve",
                (&self.subscriber, &self.contract, allowance, live_until).into_val(env),
            ),
        ];
        let root = MockAuthInvoke {
            contract: &self.contract,
            fn_name: "subscribe",
            args: (&self.subscriber, PLAN, periods, live_until).into_val(env),
            sub_invokes: &sub_invokes,
        };
        self.client
            .mock_auths(&[MockAuth {
                address: &self.subscriber,
                invoke: &root,
            }])
            .try_subscribe(&self.subscriber, &PLAN, &periods, &live_until)
            .map(|r| r.unwrap())
            .map_err(|e| e.expect("contract error"))
    }

    fn charge_as(&self, who: &Address, sub_id: u64) -> Result<crate::ChargeOutcome, Error> {
        self.client
            .mock_auths(&[MockAuth {
                address: who,
                invoke: &invoke(&self.contract, "charge", (sub_id,).into_val(&self.env)),
            }])
            .try_charge(&sub_id)
            .map(|r| r.unwrap())
            .map_err(|e| e.expect("contract error"))
    }

    fn charge(&self, sub_id: u64) -> Result<crate::ChargeOutcome, Error> {
        self.charge_as(&self.keeper.clone(), sub_id)
    }

    fn cancel_as(&self, who: &Address, sub_id: u64) -> Result<(), Error> {
        self.client
            .mock_auths(&[MockAuth {
                address: who,
                invoke: &invoke(&self.contract, "cancel", (who, sub_id).into_val(&self.env)),
            }])
            .try_cancel(who, &sub_id)
            .map(|r| r.unwrap())
            .map_err(|e| e.expect("contract error"))
    }

    fn set_paused(&self, paused: bool) {
        self.client
            .mock_auths(&[MockAuth {
                address: &self.admin,
                invoke: &invoke(&self.contract, "set_paused", (paused,).into_val(&self.env)),
            }])
            .set_paused(&paused);
    }

    fn at(&self, timestamp: u64) {
        self.env.ledger().with_mut(|l| l.timestamp = timestamp);
    }

    fn balance(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }
}

// ── Invariants (context §14.3) ───────────────────────────────────────────────

#[test]
fn subscribe_pays_first_period_to_merchant_and_sets_allowance() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    assert_eq!(id, 1);
    assert_eq!(s.balance(&s.merchant), PRICE);
    assert_eq!(s.token.allowance(&s.subscriber, &s.contract), 3 * PRICE);
    let sub = s.client.get(&id);
    assert_eq!(sub.price, PRICE);
    assert_eq!(sub.next_charge_at, START + INTERVAL);
    assert_eq!(sub.status, SubStatus::Active);
}

#[test]
fn every_transfer_goes_to_the_construction_time_merchant() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    let new_keeper = Address::generate(&s.env);
    s.client
        .mock_auths(&[MockAuth {
            address: &s.admin,
            invoke: &invoke(&s.contract, "set_keeper", (&new_keeper,).into_val(&s.env)),
        }])
        .set_keeper(&new_keeper);
    s.at(START + INTERVAL);
    s.charge_as(&new_keeper, id).unwrap();
    assert_eq!(s.client.merchant(), s.merchant);
    assert_eq!(s.balance(&s.merchant), 2 * PRICE);
    assert_eq!(s.balance(&s.keeper), 0);
    assert_eq!(s.balance(&new_keeper), 0);
    assert_eq!(s.balance(&s.admin), 0);
}

#[test]
fn price_is_locked_even_if_the_plan_price_changes() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.set_plan_as(&s.admin.clone(), PLAN, 5 * PRICE, INTERVAL, true)
        .unwrap();
    s.at(START + INTERVAL);
    let outcome = s.charge(id).unwrap();
    assert_eq!(outcome.amount, PRICE);
    assert_eq!(s.client.get(&id).price, PRICE);
    assert_eq!(s.balance(&s.merchant), 2 * PRICE);
}

#[test]
fn second_charge_in_the_same_period_fails() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.at(START + INTERVAL);
    s.charge(id).unwrap();
    assert_eq!(s.charge(id), Err(Error::NotDue));
    s.at(START + 2 * INTERVAL - 1);
    assert_eq!(s.charge(id), Err(Error::NotDue));
    assert_eq!(s.balance(&s.merchant), 2 * PRICE);
}

#[test]
fn charge_before_due_fails() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.at(START + INTERVAL - 1);
    assert_eq!(s.charge(id), Err(Error::NotDue));
}

#[test]
fn charge_on_canceled_subscription_fails_without_transfer() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.cancel_as(&s.subscriber.clone(), id).unwrap();
    s.at(START + INTERVAL);
    let before = s.balance(&s.subscriber);
    assert_eq!(s.charge(id), Err(Error::NotActive));
    assert_eq!(s.balance(&s.subscriber), before);
    assert_eq!(s.balance(&s.merchant), PRICE);
}

#[test]
fn charge_while_paused_fails_without_transfer() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.set_paused(true);
    assert!(s.client.is_paused());
    s.at(START + INTERVAL);
    let before = s.balance(&s.subscriber);
    assert_eq!(s.charge(id), Err(Error::Paused));
    assert_eq!(s.balance(&s.subscriber), before);
    s.set_paused(false);
    assert!(s.charge(id).is_ok());
}

#[test]
fn subscribe_while_paused_fails() {
    let s = Setup::new();
    s.set_paused(true);
    assert_eq!(s.subscribe(3), Err(Error::Paused));
}

#[test]
fn allowance_overflow_aborts() {
    let s = Setup::new();
    let huge = i128::MAX / 2 + 1;
    s.set_plan_as(&s.admin.clone(), PLAN, huge, INTERVAL, true)
        .unwrap();
    assert_eq!(s.subscribe_with_price(2, huge), Err(Error::Overflow));
}

#[test]
fn late_charge_starts_a_fresh_period_and_never_back_charges() {
    let s = Setup::new();
    let id = s.subscribe(5).unwrap();
    let late = START + 3 * INTERVAL + 7;
    s.at(late);
    let outcome = s.charge(id).unwrap();
    assert_eq!(outcome.next_charge_at, late + INTERVAL);
    assert_eq!(s.charge(id), Err(Error::NotDue));
    assert_eq!(s.balance(&s.merchant), 2 * PRICE);
}

#[test]
fn slightly_late_charge_keeps_the_schedule() {
    let s = Setup::new();
    let id = s.subscribe(5).unwrap();
    s.at(START + INTERVAL + 3_600);
    assert_eq!(s.charge(id).unwrap().next_charge_at, START + 2 * INTERVAL);
}

#[test]
fn charge_fails_once_the_allowance_is_used_up() {
    let s = Setup::new();
    let id = s.subscribe(1).unwrap();
    s.at(START + INTERVAL);
    s.charge(id).unwrap();
    s.at(START + 2 * INTERVAL);
    let before = s.balance(&s.subscriber);
    let result = s
        .client
        .mock_auths(&[MockAuth {
            address: &s.keeper,
            invoke: &invoke(&s.contract, "charge", (id,).into_val(&s.env)),
        }])
        .try_charge(&id);
    assert!(result.is_err());
    assert_eq!(s.balance(&s.subscriber), before);
}

// ── Authorization ────────────────────────────────────────────────────────────

#[test]
fn only_the_keeper_can_charge() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    s.at(START + INTERVAL);
    for who in [
        s.admin.clone(),
        s.subscriber.clone(),
        s.merchant.clone(),
        Address::generate(&s.env),
    ] {
        let result = s
            .client
            .mock_auths(&[MockAuth {
                address: &who,
                invoke: &invoke(&s.contract, "charge", (id,).into_val(&s.env)),
            }])
            .try_charge(&id);
        assert!(result.is_err(), "charge by a non-keeper must fail");
    }
    assert_eq!(s.balance(&s.merchant), PRICE);
}

#[test]
fn only_subscriber_or_admin_can_cancel() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    let stranger = Address::generate(&s.env);
    assert_eq!(s.cancel_as(&stranger, id), Err(Error::Unauthorized));
    assert_eq!(s.cancel_as(&s.keeper.clone(), id), Err(Error::Unauthorized));
    s.cancel_as(&s.admin.clone(), id).unwrap();
    assert_eq!(s.client.get(&id).status, SubStatus::Canceled);
    assert_eq!(
        s.cancel_as(&s.subscriber.clone(), id),
        Err(Error::NotActive)
    );
}

#[test]
fn cancel_requires_the_callers_own_signature() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    let stranger = Address::generate(&s.env);
    // The stranger signs, but claims to be the subscriber.
    let result = s
        .client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &invoke(&s.contract, "cancel", (&s.subscriber, id).into_val(&s.env)),
        }])
        .try_cancel(&s.subscriber, &id);
    assert!(result.is_err());
    assert_eq!(s.client.get(&id).status, SubStatus::Active);
}

#[test]
fn subscribe_requires_the_subscribers_signature() {
    let s = Setup::new();
    let stranger = Address::generate(&s.env);
    let live_until = s.live_until();
    let result = s
        .client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &invoke(
                &s.contract,
                "subscribe",
                (&s.subscriber, PLAN, 3_u32, live_until).into_val(&s.env),
            ),
        }])
        .try_subscribe(&s.subscriber, &PLAN, &3, &live_until);
    assert!(result.is_err());
    assert_eq!(s.balance(&s.merchant), 0);
}

#[test]
fn only_admin_manages_plans_pause_keeper_and_upgrade() {
    let s = Setup::new();
    let env = &s.env;
    let stranger = Address::generate(env);
    assert!(
        s.client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &invoke(
                    &s.contract,
                    "set_plan",
                    (2_u32, PRICE, INTERVAL, true).into_val(env)
                ),
            }])
            .try_set_plan(&2, &PRICE, &INTERVAL, &true)
            .is_err()
    );
    assert!(
        s.client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &invoke(&s.contract, "set_paused", (true,).into_val(env)),
            }])
            .try_set_paused(&true)
            .is_err()
    );
    assert!(
        s.client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &invoke(&s.contract, "set_keeper", (&stranger,).into_val(env)),
            }])
            .try_set_keeper(&stranger)
            .is_err()
    );
    let hash = soroban_sdk::BytesN::from_array(env, &[7; 32]);
    assert!(
        s.client
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &invoke(&s.contract, "upgrade", (&hash,).into_val(env)),
            }])
            .try_upgrade(&hash)
            .is_err()
    );
    assert!(!s.client.is_paused());
}

// ── Validation ───────────────────────────────────────────────────────────────

#[test]
fn plan_validation() {
    let s = Setup::new();
    let admin = s.admin.clone();
    assert_eq!(
        s.set_plan_as(&admin, 2, 0, INTERVAL, true),
        Err(Error::InvalidPrice)
    );
    assert_eq!(
        s.set_plan_as(&admin, 2, -1, INTERVAL, true),
        Err(Error::InvalidPrice)
    );
    assert_eq!(
        s.set_plan_as(&admin, 2, PRICE, MIN_INTERVAL_SECS - 1, true),
        Err(Error::InvalidInterval)
    );
    assert_eq!(s.client.try_plan(&99), Err(Ok(Error::PlanNotFound)));
}

#[test]
fn subscribe_validation() {
    let s = Setup::new();
    assert_eq!(s.subscribe(0), Err(Error::InvalidPeriods));
    s.set_plan_as(&s.admin.clone(), PLAN, PRICE, INTERVAL, false)
        .unwrap();
    assert_eq!(s.subscribe(3), Err(Error::PlanInactive));
    assert_eq!(s.client.try_get(&42), Err(Ok(Error::SubscriptionNotFound)));
}

#[test]
fn subscription_ids_increase() {
    let s = Setup::new();
    assert_eq!(s.subscribe(1).unwrap(), 1);
    assert_eq!(s.subscribe(1).unwrap(), 2);
}

// ── Events ───────────────────────────────────────────────────────────────────

#[test]
fn state_changes_emit_events_with_the_subscription_id() {
    let s = Setup::new();
    let id = s.subscribe(3).unwrap();
    let created = SubCreated {
        sub_id: id,
        subscriber: s.subscriber.clone(),
        plan_id: PLAN,
        price: PRICE,
        next_charge_at: START + INTERVAL,
    };
    let ours = s.env.events().all().filter_by_contract(&s.contract);
    assert_eq!(
        ours.events().last(),
        Some(&created.to_xdr(&s.env, &s.contract))
    );

    s.at(START + INTERVAL);
    s.charge(id).unwrap();
    let charged = Charged {
        sub_id: id,
        amount: PRICE,
        next_charge_at: START + 2 * INTERVAL,
    };
    let ours = s.env.events().all().filter_by_contract(&s.contract);
    assert_eq!(
        ours.events().last(),
        Some(&charged.to_xdr(&s.env, &s.contract))
    );

    s.cancel_as(&s.subscriber.clone(), id).unwrap();
    let canceled = Canceled {
        sub_id: id,
        by: s.subscriber.clone(),
    };
    let ours = s.env.events().all().filter_by_contract(&s.contract);
    assert_eq!(
        ours.events().last(),
        Some(&canceled.to_xdr(&s.env, &s.contract))
    );
}

// ── Property tests: random call sequences ────────────────────────────────────

#[derive(Debug, Clone)]
enum Step {
    Advance(u64),
    Charge,
}

fn steps() -> impl Strategy<Value = std::vec::Vec<Step>> {
    prop::collection::vec(
        prop_oneof![
            (0..3 * INTERVAL).prop_map(Step::Advance),
            Just(Step::Charge),
        ],
        1..25,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Whatever the timing: the merchant receives exactly price × (1 + successful charges),
    /// a charge only succeeds when due, never twice per period, and the schedule only moves forward.
    #[test]
    fn charging_never_overcharges(seq in steps()) {
        let s = Setup::new();
        let id = s.subscribe(30).unwrap();
        let mut now = START;
        let mut charges: i128 = 0;
        for step in seq {
            match step {
                Step::Advance(dt) => { now += dt; s.at(now); }
                Step::Charge => {
                    let due = s.client.get(&id).next_charge_at;
                    match s.charge(id) {
                        Ok(out) => {
                            prop_assert!(now >= due);
                            prop_assert!(out.next_charge_at > now);
                            prop_assert!(out.next_charge_at <= now + INTERVAL);
                            charges += 1;
                        }
                        Err(e) => {
                            prop_assert_eq!(e, Error::NotDue);
                            prop_assert!(now < due);
                        }
                    }
                }
            }
        }
        prop_assert_eq!(s.balance(&s.merchant), PRICE * (1 + charges));
    }
}
