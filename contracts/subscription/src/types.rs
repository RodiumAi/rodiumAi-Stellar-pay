use soroban_sdk::{Address, contracterror, contracttype};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    PlanNotFound = 3,
    PlanInactive = 4,
    InvalidPrice = 5,
    InvalidInterval = 6,
    InvalidPeriods = 7,
    SubscriptionNotFound = 8,
    NotActive = 9,
    NotDue = 10,
    Paused = 11,
    Overflow = 12,
    Unauthorized = 13,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub price: i128,
    pub interval_secs: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SubStatus {
    Active,
    Canceled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub subscriber: Address,
    pub plan_id: u32,
    /// Locked at creation; plan price changes never reach existing subscriptions.
    pub price: i128,
    pub interval_secs: u64,
    pub next_charge_at: u64,
    pub status: SubStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChargeOutcome {
    pub sub_id: u64,
    pub amount: i128,
    pub next_charge_at: u64,
}
