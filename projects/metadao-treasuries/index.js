// Place under MetaDAO parent project as "Futarchy DAO Treasuries"
// Sum of Futarchy DAO treasury balances, Futarchy DAO-owned Meteora DAMM v2 LP positions, and Futarchy DAO-owned Futarchy AMM positions
    // In total MetaDAO project TVL there will be overlap between Futarchy AMM TVL and Futarchy DAO Treasuries (this adapter) because DAOs own part of the Futarchy AMM TVL through LP positions
        // Printed is Futarchy DAO-owned LP TVL for visibility so it can be backed out of rolled up TVL in DeFiLlama
const { getConnection, sumTokens2 } = require('../helper/solana')
const { PublicKey, Keypair } = require('@solana/web3.js')
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor')
const { FutarchyClient } = require("@metadaoproject/futarchy/v0.6")
const { CpAmm } = require("@meteora-ag/cp-amm-sdk")
const anchor = require("@coral-xyz/anchor")
const crypto = require("crypto")
const BN = require('bn.js')

// Define throttle
const SLEEP_MS = 5000
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Targeted tokens
const TOKEN_PROGRAM_IDS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // SPL Token
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022
]

// DAMM v2 program - position PDAs derived from
const DAMM_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG")

// Futarchy AMM program
const FUTARCHY_AMM_PROGRAM_ID = new PublicKey(
  "FUTARELBfJfQ8RDGhg1wdhddq1odMAJUePHFuBYfUxKq"
)

// Retry helper
async function fetchWithRetry(fetchFn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetchFn()
    } catch (e) {
      if (e.message.includes('429') && i < maxRetries - 1) {
        const backoff = Math.pow(2, i) * 1000
        console.log(`Rate limited, waiting ${backoff}ms...`)
        await sleep(backoff)
        continue
      }
      throw e
    }
  }
}

async function rpcCall(fn, ...args) {
  let delay = 500
  while (true) {
    try {
      await sleep(SLEEP_MS)
      return await fn(...args)
    } catch (e) {
      const msg = e?.message || ""
      if (!msg.includes("429")) throw e
      console.log(`RPC 429, retrying in ${delay}ms...`)
      await sleep(delay)
      delay = Math.min(delay * 2, 4000)
    }
  }
}

// Futarchy AMM Discriminators
function getAmmPositionDiscriminator() {
  return crypto
    .createHash("sha256")
    .update("account:AmmPosition")
    .digest()
    .slice(0, 8)
}

function getDaoDiscriminator() {
  return crypto
    .createHash("sha256")
    .update("account:Dao")
    .digest()
    .slice(0, 8)
}

// AMM Position decoder
function decodeAmmPosition(data) {
  const disc = getAmmPositionDiscriminator()
  if (!data.slice(0, 8).equals(disc)) return null

  const dao = new PublicKey(data.slice(8, 40))
  const positionAuthority = new PublicKey(data.slice(40, 72))
  const liquidity = new anchor.BN(data.slice(72, 88), "le") // u128

  return { dao, positionAuthority, liquidity }
}

// Borsh helpers to walk FutarchyAmm inside DAO
function skipTwapOracle(data, offset) {
  return offset + 100
}

function skipPool(data, offset) {
  let o = skipTwapOracle(data, offset)
  o += 8 * 4
  return o
}

function skipPoolState(data, offset) {
  let o = offset
  const tag = data[o]
  o += 1
  if (tag === 0) {
    o = skipPool(data, o)
  } else if (tag === 1) {
    o = skipPool(data, o)
    o = skipPool(data, o)
    o = skipPool(data, o)
  } else {
    throw new Error(`Unknown PoolState tag: ${tag}`)
  }
  return o
}

function decodeDaoAmm(data) {
  const daoDisc = getDaoDiscriminator()
  if (!data.slice(0, 8).equals(daoDisc)) return null

  let o = 8 // skip discriminator

  o = skipPoolState(data, o)

  const totalLiquidity = new anchor.BN(data.slice(o, o + 16), "le")
  o += 16

  const baseMint = new PublicKey(data.slice(o, o + 32)); o += 32
  const quoteMint = new PublicKey(data.slice(o, o + 32)); o += 32
  const ammBaseVault = new PublicKey(data.slice(o, o + 32)); o += 32
  const ammQuoteVault = new PublicKey(data.slice(o, o + 32)); o += 32

  return {
    totalLiquidity,
    baseMint,
    quoteMint,
    ammBaseVault,
    ammQuoteVault,
  }
}

// Raw SPL token vault decoding
function readU64LE(buf, offset) {
  return new anchor.BN(buf.slice(offset, offset + 8), "le")
}

async function getVaultBalance(connection, vaultPk) {
  const info = await rpcCall(
    connection.getAccountInfo.bind(connection),
    vaultPk
  )

  if (!info?.data) return new anchor.BN(0)

  const buf = info.data

  // SPL token layout: amount @ offset 64..72 (u64 LE)
  return readU64LE(buf, 64)
}

// Futarchy AMM TVL
async function getFutarchyAmmTvl(connection) {
  const balances = {}

  console.log("\n=== Futarchy AMM LP Positions ===")
  console.log("Step 1: Fetching all DAO accounts...")

  const daoDisc = getDaoDiscriminator()

  const daoAccounts = await rpcCall(
    connection.getProgramAccounts.bind(connection),
    FUTARCHY_AMM_PROGRAM_ID,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(daoDisc),
          },
        },
      ],
    }
  )

  console.log("Found DAO accounts:", daoAccounts.length)

  const daoAmmMap = new Map()
  for (const acc of daoAccounts) {
    try {
      const ammView = decodeDaoAmm(acc.account.data)
      if (ammView) daoAmmMap.set(acc.pubkey.toString(), ammView)
    } catch (e) {
      console.log(`Failed to decode Dao AMM for ${acc.pubkey.toString()}`, e.message)
    }
  }

  console.log("Decoded AMM view for DAOs:", daoAmmMap.size)

  console.log("Step 2: Fetching all LP positions...")

  const ammDisc = getAmmPositionDiscriminator()

  const posAccounts = await rpcCall(
    connection.getProgramAccounts.bind(connection),
    FUTARCHY_AMM_PROGRAM_ID,
    {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode(ammDisc),
          },
        },
      ],
    }
  )

  console.log("Found AmmPosition accounts:", posAccounts.length)

  const daoOwnedPositions = []

  for (const acc of posAccounts) {
    const p = decodeAmmPosition(acc.account.data)
    if (!p) continue
    if (daoAmmMap.has(p.dao.toString())) {
      daoOwnedPositions.push(p)
    }
  }

  console.log("DAO-owned LP positions:", daoOwnedPositions.length)

  // Group by DAO pubkey
  const byDao = {}
  for (const p of daoOwnedPositions) {
    const k = p.dao.toString()
    if (!byDao[k]) byDao[k] = []
    byDao[k].push(p)
  }

  for (const [daoPk, positions] of Object.entries(byDao)) {
    const ammView = daoAmmMap.get(daoPk)
    if (!ammView) continue

    const {
      totalLiquidity,
      baseMint,
      quoteMint,
      ammBaseVault,
      ammQuoteVault,
    } = ammView

    if (totalLiquidity.isZero()) continue

    let baseVaultBal, quoteVaultBal

    try {
      baseVaultBal = await getVaultBalance(connection, ammBaseVault)
      quoteVaultBal = await getVaultBalance(connection, ammQuoteVault)
    } catch (e) {
      console.log(`Skipping DAO ${daoPk} due to vault error:`, e.message)
      continue
    }

    const baseMintKey = `solana:${baseMint}`
    const quoteMintKey = `solana:${quoteMint}`

    for (const p of positions) {
      const PRECISION = new anchor.BN("1000000000000000000") // 1e18
      const share = p.liquidity.mul(PRECISION).div(totalLiquidity)

      const allocBase = baseVaultBal.mul(share).div(PRECISION)
      const allocQuote = quoteVaultBal.mul(share).div(PRECISION)

      balances[baseMintKey] = (balances[baseMintKey] || 0) + Number(allocBase)
      balances[quoteMintKey] = (balances[quoteMintKey] || 0) + Number(allocQuote)
    }
  }

  console.log("Futarchy AMM tokens discovered:", Object.keys(balances).length)
  return balances
}

// FutarchyService (https://github.com/metaDAOproject/futarchy-coingecko-api/blob/e22678298032647c4e9aa6050ac120bc3b03ebe4/src/services/futarchyService.ts)
class FutarchyService {
  constructor(connection) {
    this.connection = connection

    let wallet
    try { wallet = Wallet.local() }
    catch (_) { wallet = new Wallet(Keypair.generate()) }

    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    })

    this.client = FutarchyClient.createClient({ provider })
  }

  async getAllDaos() {
    const rawDaos = await this.client.autocrat.account.dao.all()

    const daos = rawDaos
      .filter(d => d.account.squadsMultisigVault)
      .map(d => ({
        daoAddress: d.publicKey.toString(),
        treasuryVaultAddress: d.account.squadsMultisigVault.toString(),
      }))

    return daos
  }
}

// Meteora DAMM; Derive PDA - NFT Mint <> Position PDA
function derivePositionPdaFromMint(mint) {
  const mintKey = new PublicKey(mint)

  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      mintKey.toBuffer(),
    ],
    DAMM_PROGRAM_ID
  )

  return pda
}

// METEORA position decoding
async function getMeteoraPositionBalances(connection, positionPda) {
  try {
    const cpAmm = new CpAmm(connection)

    const positionState = await fetchWithRetry(() => 
      cpAmm.fetchPositionState(positionPda)
    )

    const poolAddress = positionState.pool
    const poolState = await fetchWithRetry(() => 
      cpAmm.fetchPoolState(poolAddress)
    )

    const liquidity = new BN(positionState.unlockedLiquidity, 16)

    const sqrtPrice = new BN(poolState.sqrtPrice, 16)
    const sqrtMinPrice = new BN(poolState.sqrtMinPrice, 16)
    const sqrtMaxPrice = new BN(poolState.sqrtMaxPrice, 16)

    const quote = await cpAmm.getWithdrawQuote({
      liquidityDelta: liquidity,
      sqrtPrice,
      minSqrtPrice: sqrtMinPrice,
      maxSqrtPrice: sqrtMaxPrice,
    })

    return {
      tokenAMint: poolState.tokenAMint.toString(),
      tokenBMint: poolState.tokenBMint.toString(),
      tokenAAmount: quote.outAmountA.toString(),
      tokenBAmount: quote.outAmountB.toString(),
    }

  } catch (e) {
    console.error("Decode error:", positionPda.toString(), e.message)
    return null
  }
}

// Combined TVL
async function tvl() {
  const connection = getConnection()

  // Futarchy AMM LP positions
  const ammBalances = await getFutarchyAmmTvl(connection)

  // Print overlapped TVL with Futarchy AMM
  console.log("== Double Counted TVL ==");
  for (const [mint, amt] of Object.entries(ammBalances)) {
    console.log(mint, amt.toString());
  }

  // Futarchy DAO multisig vaults
  console.log("\n=== Futarchy Vaults & Meteora ===")
  const service = new FutarchyService(connection)
  console.log("Fetching Futarchy DAOs...")

  const daos = await service.getAllDaos()
  const vaults = daos.map(d => d.treasuryVaultAddress)

  console.log("Found", vaults.length, "Futarchy vaults")

  // Add MetaDAO treasury
  vaults.push("BxgkvRwqzYFWuDbRjfTYfgTtb41NaFw1aQ3129F79eBT")

  const futarchyTokenAccounts = []
  const nftMints = new Set()
  const tokenAccountResults = []
  
  for (const vault of vaults) {
    const accounts = []
    
    for (const PROGRAM of TOKEN_PROGRAM_IDS) {
      try {
        await sleep(SLEEP_MS)
        const resp = await fetchWithRetry(() =>
          connection.getParsedTokenAccountsByOwner(
            new PublicKey(vault),
            { programId: PROGRAM },
          )
        )
        accounts.push(...resp.value)
      } catch (e) {
        console.log("Vault fetch error:", vault, e.message)
      }
    }
    
    tokenAccountResults.push(accounts)
  }

  // Process results
  tokenAccountResults.flat().forEach(acc => {
    futarchyTokenAccounts.push(acc.pubkey.toString())
    const info = acc.account.data.parsed.info
    if (info.tokenAmount.amount === "1") {
      nftMints.add(info.mint)
    }
  })

  console.log("Total Futarchy token accounts:", futarchyTokenAccounts.length)
  console.log("Discovered Meteora NFT mints:", nftMints.size)

  // Derive position PDAs
  const positionPdas = [...nftMints].map(mint => derivePositionPdaFromMint(mint))

  console.log("Derived position PDAs:", positionPdas.length)

  // Process Meteora positions
  const meteoraBalances = {}

  for (const pda of positionPdas) {
    await sleep(SLEEP_MS)
    const decoded = await getMeteoraPositionBalances(connection, pda)
    if (!decoded) continue

    meteoraBalances[decoded.tokenAMint] =
      (meteoraBalances[decoded.tokenAMint] || 0n) + BigInt(decoded.tokenAAmount)
    meteoraBalances[decoded.tokenBMint] =
      (meteoraBalances[decoded.tokenBMint] || 0n) + BigInt(decoded.tokenBAmount)
  }

  const formatted = { ...ammBalances }
  for (const [mint, amount] of Object.entries(meteoraBalances)) {
    const key = `solana:${mint}`
    formatted[key] = (formatted[key] || 0) + Number(amount)
  }

  console.log("Meteora tokens discovered:", Object.keys(meteoraBalances).length)
  console.log("\nTotal unique tokens:", Object.keys(formatted).length)

  return sumTokens2({
    chain: 'solana',
    tokenAccounts: futarchyTokenAccounts,
    balances: formatted,
  })
}

module.exports = {
  timetravel: false,
  methodology:
    "Sum of Futarchy DAO Squads multisig vault SPL token balances, value of Futarchy DAO owned Meteora DAMM v2 LP positions, and DAO-owned Futarchy AMM LP positions.",
  solana: { tvl },
}
