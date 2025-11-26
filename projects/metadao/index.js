// Place under MetaDAO parent project as "Futarchy DAO Treasuries"
const { getConnection, sumTokens2 } = require('../helper/solana')
const { PublicKey, Connection, Keypair } = require('@solana/web3.js')
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor')
const { FutarchyClient } = require("@metadaoproject/futarchy/v0.6")
const { CpAmm } = require("@meteora-ag/cp-amm-sdk")
const BN = require('bn.js')

// Define throttle
const SLEEP_MS = 5000
const sleep = ms => new Promise(r => setTimeout(r, ms))

// METEORA DAMM v2 positions - need to add autodiscovery
const METEORA_POSITIONS = [
  "FWyVZjMDT65bDCtHTmko7xStTWw5VmHc4n2jhQLBQKbx",
  "DZc1Smsn5n7TCEDyivJs61dPzJem2661fnvYw2ZEMJFa",
  "CdBXZ7iodqp95tZuk7SUHfBn5a4PKUbjHqnx5N33zNyM",
  "272QA5FcueuVSX1UzVRFFdnfHBkULnLFARautuDw5zVG",
  "AYmr1foBaTGLTnHZhETQXjRWsi8UNvTK4uPRFHe9cd97",
  "APEYaGFGg8LYxNhNgvn5EH3mhDz62GQC3cURouSRBsVK",
].map(addr => new PublicKey(addr))

// Targeted tokens
const TOKEN_PROGRAM_IDS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // SPL Token
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022
]

// FutarchyService (https://github.com/metaDAOproject/futarchy-coingecko-api/blob/e22678298032647c4e9aa6050ac120bc3b03ebe4/src/services/futarchyService.ts)
class FutarchyService {
  constructor() {
    const rpc = "https://api.mainnet-beta.solana.com"
    this.connection = new Connection(rpc, 'confirmed')

    let wallet
    try {
      wallet = Wallet.local()
    } catch (_) {
      wallet = new Wallet(Keypair.generate())
    }

    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    })

    this.client = FutarchyClient.createClient({ provider })
  }

  async getAllDaos() {
    const rawDaos = await this.client.autocrat.account.dao.all()
    await sleep(SLEEP_MS)

    const daos = []

    for (let i = 0; i < rawDaos.length; i++) {
      const dao = rawDaos[i].account

      if (dao.squadsMultisigVault) {
        daos.push({
          daoAddress: rawDaos[i].publicKey.toString(),
          treasuryVaultAddress: dao.squadsMultisigVault.toString(),
        })
      }

      await sleep(SLEEP_MS)
    }

    return daos
  }
}

// METEORA position decoding
async function getMeteoraPositionBalances(connection, positionAddress) {
  try {
    const cpAmm = new CpAmm(connection)

    const positionState = await cpAmm.fetchPositionState(positionAddress)
    await sleep(SLEEP_MS)

    const poolAddress = positionState.pool
    const poolState = await cpAmm.fetchPoolState(poolAddress)
    await sleep(SLEEP_MS)

    const liquidity = new BN(positionState.unlockedLiquidity, 16)

    const sqrtPrice = new BN(poolState.sqrtPrice, 16)
    const sqrtMinPrice = new BN(poolState.sqrtMinPrice, 16)
    const sqrtMaxPrice = new BN(poolState.sqrtMaxPrice, 16)

    const withdrawQuote = await cpAmm.getWithdrawQuote({
      liquidityDelta: liquidity,
      sqrtPrice,
      minSqrtPrice: sqrtMinPrice,
      maxSqrtPrice: sqrtMaxPrice,
    })

    return {
      tokenAMint: poolState.tokenAMint.toString(),
      tokenBMint: poolState.tokenBMint.toString(),
      tokenAAmount: withdrawQuote.outAmountA.toString(),
      tokenBAmount: withdrawQuote.outAmountB.toString(),
    }
  } catch (e) {
    console.error("Meteora position error", positionAddress.toString(), ":", e.message)
    return null
  }
}


// Combined TVL
async function tvl() {
  const connection = getConnection()

  // Futarchy DAO multisig vaults
  const service = new FutarchyService()
  console.log("Fetching Futarchy DAOs...")

  const daos = await service.getAllDaos()
  const vaults = daos.map(d => d.treasuryVaultAddress)

  console.log("Found", vaults.length, "Futarchy vaults")

  const futarchyTokenAccounts = []

  for (const vault of vaults) {
    console.log("Vault:", vault)

    for (const PROGRAM_ID of TOKEN_PROGRAM_IDS) {
      try {
        const resp = await connection.getTokenAccountsByOwner(
          new PublicKey(vault),
          { programId: PROGRAM_ID }
        )
        await sleep(SLEEP_MS)

        for (const acc of resp.value) {
          futarchyTokenAccounts.push(acc.pubkey.toString())
        }
      } catch (e) {
        console.log("Vault fetch error:", vault, e.message)
        await sleep(SLEEP_MS)
      }
    }
  }

  const uniqueTokenAccounts = [...new Set(futarchyTokenAccounts)]
  console.log("Total Futarchy token accounts:", uniqueTokenAccounts.length)

  // Meteora DAMM v2 positions
  console.log("Fetching Meteora Position Liquidity...")

  const meteoraBalances = {}

  for (const position of METEORA_POSITIONS) {
    const balances = await getMeteoraPositionBalances(connection, position)

    if (!balances) continue

    // Token A
    if (!meteoraBalances[balances.tokenAMint]) meteoraBalances[balances.tokenAMint] = 0n
    meteoraBalances[balances.tokenAMint] += BigInt(balances.tokenAAmount)

    // Token B
    if (!meteoraBalances[balances.tokenBMint]) meteoraBalances[balances.tokenBMint] = 0n
    meteoraBalances[balances.tokenBMint] += BigInt(balances.tokenBAmount)
  }

  // Convert Meteora balances to solana:<mint> for DeFiLlama
  const meteoraFormatted = {}
  for (const [mint, amount] of Object.entries(meteoraBalances)) {
    meteoraFormatted[`solana:${mint}`] = amount.toString()
  }

  console.log("Meteora tokens discovered:", Object.keys(meteoraFormatted).length)

  // Combine
  await sleep(SLEEP_MS)

  return sumTokens2({
    chain: 'solana',

    // Futarchy vaults via token accounts
    tokenAccounts: uniqueTokenAccounts,

    // Meteora LP positions via direct mint <> amount map
    balances: meteoraFormatted,
  })
}

module.exports = {
  timetravel: false,
  methodology:
    "Sum of Futarchy DAO Squads multisig vault balances and value of Meteora DAMM v2 LP positions.",
  solana: { tvl },
}
