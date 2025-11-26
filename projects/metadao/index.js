const { getConnection, sumTokens2 } = require('../helper/solana')
const { PublicKey, Connection, Keypair } = require('@solana/web3.js')
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor')
const { FutarchyClient } = require("@metadaoproject/futarchy/v0.6")

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

// Throttle
const sleep = ms => new Promise(r => setTimeout(r, ms))

// FutarchyService (https://github.com/metaDAOproject/futarchy-coingecko-api/blob/e22678298032647c4e9aa6050ac120bc3b03ebe4/src/services/futarchyService.ts)
class FutarchyService {
  constructor() {
    // RPC for DAO discovery via FutarchyClient
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
    const daos = []

    for (let i = 0; i < rawDaos.length; i++) {
      const dao = rawDaos[i].account

      if (dao.squadsMultisigVault) {
        daos.push({
          daoAddress: rawDaos[i].publicKey.toString(),
          treasuryVaultAddress: dao.squadsMultisigVault.toString(),
        })
      }

      // Throttle DAO fetches
      if (i % 10 === 0) await sleep(5000)
    }

    return daos
  }
}

// Get TVL of squadsMultisigVault
async function tvl() {
  const service = new FutarchyService()
  const connection = getConnection()

  const daos = await service.getAllDaos()
  const vaults = daos.map(d => d.treasuryVaultAddress)

  const tokenAccounts = []

  for (const vault of vaults) {
    console.log("Vault:", vault)

    try {
      const resp = await connection.getTokenAccountsByOwner(
        new PublicKey(vault),
        { programId: TOKEN_PROGRAM_ID },
      )

      for (const acc of resp.value) {
        tokenAccounts.push(acc.pubkey.toString())
      }
    } catch (e) {
      console.log("Vault fetch error:", vault, e.message)
    }

    await sleep(5000)
  }

  const uniqueTokenAccounts = [...new Set(tokenAccounts)]
  console.log("unique token accounts:", uniqueTokenAccounts.length)

  return sumTokens2({
    chain: 'solana',
    tokenAccounts: uniqueTokenAccounts,
  })
}

module.exports = {
  timetravel: false,
  methodology:
    "Calculated as the dollarized sum of all SPL token balances held by each futarchy DAO's Squads multisig vault.",
  solana: { tvl },
}
