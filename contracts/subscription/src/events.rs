use soroban_sdk::{Address, BytesN, contractevent};

// Topic names are the snake_case struct names; packages/stellar parses
// `sub_created`, `charged` and `canceled` (context §13.4).

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubCreated {
    #[topic]
    pub sub_id: u64,
    pub subscriber: Address,
    pub plan_id: u32,
    pub price: i128,
    pub next_charge_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Charged {
    #[topic]
    pub sub_id: u64,
    pub amount: i128,
    pub next_charge_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Canceled {
    #[topic]
    pub sub_id: u64,
    pub by: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanSet {
    #[topic]
    pub plan_id: u32,
    pub price: i128,
    pub interval_secs: u64,
    pub active: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedSet {
    pub paused: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeeperSet {
    pub keeper: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub wasm_hash: BytesN<32>,
}
