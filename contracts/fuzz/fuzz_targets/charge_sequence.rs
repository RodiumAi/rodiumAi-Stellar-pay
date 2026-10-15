//! Random subscribe / advance / charge / cancel / pause sequences. Any panic or
//! broken invariant is a finding (plan §6). Mirrors the proptest in src/test.rs
//! with libFuzzer's coverage-guided inputs.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env};
use subscription::{Error, SubStatus, SubscriptionContract, SubscriptionContractClient, MIN_INTERVAL_SECS};

#[derive(Arbitrary, Debug)]
struct Input {
    price: u32,
    interval_days: u8,
    periods: u8,
    steps: Vec<Step>,
}

#[derive(Arbitrary, Debug)]
enum Step {
    Advance(u32),
    Charge,
    Cancel,
    Pause(bool),
    RepricePlan(u32),
}

fuzz_target!(|input: Input| {
    let price = i128::from(input.price.max(1));
    let interval = MIN_INTERVAL_SECS * u64::from(input.interval_days.max(1));
    let periods = u32::from(input.periods.max(1));

    let env = Env::default();
    // Auth is exercised exactly in the unit tests; here we explore state and arithmetic.
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = 1_760_000_000;
        l.sequence_number = 1_000;
    });
    let admin = Address::generate(&env);
    let merchant = Address::generate(&env);
    let keeper = Address::generate(&env);
    let subscriber = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let token = TokenClient::new(&env, &sac.address());
    StellarAssetClient::new(&env, &sac.address()).mint(&subscriber, &(price * 1_000));

    let id = env.register(SubscriptionContract, (admin, sac.address(), merchant.clone(), keeper));
    let client = SubscriptionContractClient::new(&env, &id);
    client.set_plan(&1, &price, &interval, &true);
    let live_until = env.ledger().sequence() + 100_000;
    let sub_id = client.subscribe(&subscriber, &1, &periods, &live_until);

    let mut charges: i128 = 0;
    for step in input.steps.into_iter().take(64) {
        match step {
            Step::Advance(secs) => env.ledger().with_mut(|l| l.timestamp += u64::from(secs)),
            Step::Charge => {
                let before = client.get(&sub_id);
                let now = env.ledger().timestamp();
                match client.try_charge(&sub_id) {
                    Ok(Ok(out)) => {
                        assert!(before.status == SubStatus::Active && now >= before.next_charge_at);
                        assert_eq!(out.amount, price, "price must stay locked");
                        assert!(out.next_charge_at > now && out.next_charge_at <= now + interval);
                        charges += 1;
                    }
                    Ok(Err(_)) => unreachable!("client always returns a result"),
                    Err(Ok(e)) => assert!(matches!(e, Error::NotDue | Error::NotActive | Error::Paused)),
                    // Token transfer_from failing (allowance used up) aborts the call.
                    Err(Err(_)) => assert!(charges >= i128::from(periods)),
                }
            }
            Step::Cancel => {
                let _ = client.try_cancel(&subscriber, &sub_id);
            }
            Step::Pause(p) => client.set_paused(&p),
            Step::RepricePlan(p) => client.set_plan(&1, &i128::from(p.max(1)), &interval, &true),
        }
    }
    assert_eq!(token.balance(&merchant), price * (1 + charges), "merchant receives exactly what was charged");
    assert!(charges <= i128::from(periods), "never charges beyond the approved allowance");
});
