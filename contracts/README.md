# contracts/ (Person 2)

Solidity contracts for Settld, written and tested in **Arc Studio**, then exported here.

Planned files:
- `src/Ping.sol` (S2: proves CRE → Arc → UI)
- `src/ClauseEscrow.sol` (reusable core, inherits `ReceiverTemplate`)
- `src/SettldEscrow.sol` (creator-deal app on top of `ClauseEscrow`)
- `src/JurorRegistry.sol` (V1c)
- `src/ReceiverTemplate.sol`, `src/IReceiver.sol` (from Chainlink's `cre-templates`; review before use)
- `test/` (Foundry tests, using `../shared/fixtures/`)

Rules: state is updated before any transfer · SafeERC20 + ReentrancyGuard · USDC only through the ERC-20 interface (never `msg.value`) · no admin withdrawal · every function checks its caller.

After each deploy: update the addresses in `docs/INTERFACES.md` and export the ABI to `shared/abi/`.
