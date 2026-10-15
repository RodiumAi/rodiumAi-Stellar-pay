use soroban_sdk::{Address, Env, contracttype};

use crate::fail;
use crate::types::{Error, Plan, Subscription};

/// Extend once remaining TTL drops below ~30 days of 5-second ledgers.
const TTL_THRESHOLD: u32 = 30 * 17_280;

#[contracttype]
#[derive(Clone)]
enum Key {
    Admin,
    Token,
    Merchant,
    Keeper,
    Paused,
    NextSubId,
    Plan(u32),
    Sub(u64),
}

pub fn init_config(
    env: &Env,
    admin: &Address,
    token: &Address,
    merchant: &Address,
    keeper: &Address,
) {
    let s = env.storage().instance();
    if s.has(&Key::Admin) {
        fail(env, Error::AlreadyInitialized);
    }
    s.set(&Key::Admin, admin);
    s.set(&Key::Token, token);
    s.set(&Key::Merchant, merchant);
    s.set(&Key::Keeper, keeper);
    s.set(&Key::Paused, &false);
    s.set(&Key::NextSubId, &1_u64);
    extend_instance(env);
}

pub fn extend_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD.min(max), max);
}

fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &Key) -> T {
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| fail(env, Error::NotInitialized))
}

pub fn admin(env: &Env) -> Address {
    get(env, &Key::Admin)
}

pub fn token(env: &Env) -> Address {
    get(env, &Key::Token)
}

/// Fixed at construction; no function changes it short of a contract upgrade (context §14.3).
pub fn merchant(env: &Env) -> Address {
    get(env, &Key::Merchant)
}

pub fn keeper(env: &Env) -> Address {
    get(env, &Key::Keeper)
}

pub fn set_keeper(env: &Env, keeper: &Address) {
    env.storage().instance().set(&Key::Keeper, keeper);
    extend_instance(env);
}

pub fn paused(env: &Env) -> bool {
    get(env, &Key::Paused)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&Key::Paused, &paused);
    extend_instance(env);
}

pub fn plan(env: &Env, plan_id: u32) -> Option<Plan> {
    env.storage().instance().get(&Key::Plan(plan_id))
}

pub fn set_plan(env: &Env, plan_id: u32, plan: &Plan) {
    env.storage().instance().set(&Key::Plan(plan_id), plan);
    extend_instance(env);
}

pub fn next_sub_id(env: &Env) -> Result<u64, Error> {
    let id: u64 = get(env, &Key::NextSubId);
    let next = id.checked_add(1).ok_or(Error::Overflow)?;
    env.storage().instance().set(&Key::NextSubId, &next);
    Ok(id)
}

pub fn subscription(env: &Env, sub_id: u64) -> Option<Subscription> {
    let key = Key::Sub(sub_id);
    let sub = env.storage().persistent().get(&key);
    if sub.is_some() {
        extend_persistent(env, &key);
    }
    sub
}

pub fn set_subscription(env: &Env, sub_id: u64, sub: &Subscription) {
    let key = Key::Sub(sub_id);
    env.storage().persistent().set(&key, sub);
    extend_persistent(env, &key);
}

fn extend_persistent(env: &Env, key: &Key) {
    let max = env.storage().max_ttl();
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD.min(max), max);
}
