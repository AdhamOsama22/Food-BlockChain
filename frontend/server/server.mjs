import dns from 'node:dns'

dns.setServers(['1.1.1.1', '8.8.8.8'])


import express from 'express'
import multer from 'multer'
import dotenv from 'dotenv'
import { MongoClient } from 'mongodb'
import { randomBytes } from 'node:crypto'
import { Contract, JsonRpcProvider, getAddress, isAddress, verifyMessage } from 'ethers'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT || 3001)
const HOST = '0.0.0.0'
const CHAIN_ID = 11155111n
// The contract successfully deployed to Ethereum Sepolia.
const CONTRACT_ADDRESS = '0x7ead9cd6c3843AFeaae96e77959d2DC44809429e'

// Server-only RPC: never put private wallet keys in frontend/.env.
// For better reliability use a Sepolia HTTPS endpoint from your RPC provider.
const RPC_URL = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const chain = new JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true })
const rolesContract = new Contract(CONTRACT_ADDRESS, [
  'function DEFAULT_ADMIN_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)'
], chain)

// One-use, short-lived wallet challenges; never accept an unsigned claimed admin address.
const challenges = new Map()
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000
function requireLocalOrigin(req, res, next) {
  if (!allowedOrigins.includes(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin not allowed.' })
  }
  next()
}
function validAddress(value) {
  return typeof value === 'string' && isAddress(value)
}
function cleanName(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}


const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  process.env.FRONTEND_URL
].filter(Boolean)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    const isPdf =
      file.mimetype === 'application/pdf' &&
      file.originalname.toLowerCase().endsWith('.pdf')

    if (isPdf) {
      callback(null, true)
    } else {
      callback(new Error('Only PDF files are allowed.'))
    }
  }
})

// MongoDB is accessed only by this server, never directly by React.
let mongoClient = null
let database = null

async function connectMongoDB() {
  const uri = process.env.MONGODB_URI

  if (!uri) {
    throw new Error('MONGODB_URI is missing from the frontend/.env file.')
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000
  })

  try {
    await client.connect()
    const db = client.db('organictrace')
    await db.command({ ping: 1 })

    // Existing MongoDB participant names are preserved across this migration.
    // Prepare collections for authenticated API routes.
    // Addresses should be normalized to lower case when storing profiles.
    await db.collection('participants').createIndex(
      { walletAddress: 1 },
      { unique: true }
    )
    await db.collection('batchDetails').createIndex(
      { chainId: 1, contractAddress: 1, batchId: 1 },
      { unique: true }
    )

    mongoClient = client
    database = db
    console.log('MongoDB Atlas connected successfully (database: organictrace).')
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

// Allow requests from the local React website.
app.use((req, res, next) => {
  const origin = req.headers.origin

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// Check that both the server and MongoDB are running.
app.use('/api', express.json({ limit: '16kb' }))

app.get('/health', async (req, res) => {
  if (!database) {
    return res.status(503).json({
      status: 'error',
      mongodb: 'disconnected'
    })
  }

  try {
    await database.command({ ping: 1 })
    res.json({ status: 'ok', mongodb: 'connected' })
  } catch {
    res.status(503).json({ status: 'error', mongodb: 'disconnected' })
  }
})

// Public, read-only labels. Previous Hardhat participant names remain available as
// off-chain display labels; they are NOT proof of a role on Sepolia.
// The next successful Admin update associates a profile with Sepolia.
app.get('/api/participants', async (req, res) => {
  try {
    const docs = await database.collection('participants')
      .find({}, { projection: { _id: 0, walletAddress: 1, name: 1 } })
      .limit(1000).toArray()
    res.setHeader('Cache-Control', 'no-store')
    res.json({ participants: docs })
  } catch (error) {
    console.error('Read participants:', error.message)
    res.status(503).json({ error: 'Could not retrieve participant names.' })
  }
})

// Request a short-lived message to sign with the currently selected Admin wallet.
app.post('/api/participants/challenge', requireLocalOrigin, async (req, res) => {
  const { adminAddress: address, walletAddress, name } = req.body || {}
  const sanitized = cleanName(name)
  if (!validAddress(address) || !validAddress(walletAddress) || !sanitized || sanitized.length > 100) {
    return res.status(400).json({ error: 'Invalid admin, participant wallet, or name.' })
  }
  try {
    const role = await rolesContract.DEFAULT_ADMIN_ROLE()
    if (!await rolesContract.hasRole(role, address)) {
      return res.status(403).json({ error: 'The signing wallet is not an on-chain Administrator.' })
    }
    const nonce = randomBytes(24).toString('hex')
    const expiry = Date.now() + CHALLENGE_LIFETIME_MS
    const normalized = getAddress(address)
    const message = [
      'OrganicTrace participant profile authorization',
      `Admin: ${normalized}`,
      `Chain ID: ${CHAIN_ID}`,
      `Contract: ${CONTRACT_ADDRESS}`,
      `Participant wallet: ${getAddress(walletAddress)}`,
      `Participant name: ${sanitized}`,
      `Nonce: ${nonce}`,
      `Expires: ${new Date(expiry).toISOString()}`
    ].join('\n')
    // Remove old challenges for this admin and expired challenges (avoid unbounded growth).
    for (const [key, value] of challenges) {
      if (value.expiry < Date.now() || value.adminAddress === normalized.toLowerCase()) challenges.delete(key)
    }
    challenges.set(nonce, { message, expiry, adminAddress: normalized.toLowerCase(), walletAddress: getAddress(walletAddress).toLowerCase(), name: sanitized })
    res.json({ message, nonce })
  } catch (error) {
    console.error('Admin role check:', error.message)
    res.status(503).json({ error: 'Could not verify the on-chain Administrator on Sepolia. Check the Sepolia RPC connection.' })
  }
})

// Only a fresh signature by a wallet currently holding DEFAULT_ADMIN_ROLE can edit names.
app.put('/api/participants', requireLocalOrigin, async (req, res) => {
  const { walletAddress, name, signature, nonce } = req.body || {}
  if (!validAddress(walletAddress) || typeof signature !== 'string' || typeof nonce !== 'string') {
    return res.status(400).json({ error: 'Invalid participant or authorization information.' })
  }
  const cleaned = cleanName(name)
  if (!cleaned || cleaned.length > 100) {
    return res.status(400).json({ error: 'Participant name must be 1–100 characters.' })
  }
  const challenge = challenges.get(nonce)
  if (!challenge) return res.status(401).json({ error: 'Authorization expired. Please sign again.' })
  challenges.delete(nonce) // one-use even on failed attempts
  if (challenge.expiry < Date.now()) return res.status(401).json({ error: 'Authorization expired.' })
  if (challenge.walletAddress !== getAddress(walletAddress).toLowerCase() || cleaned !== challenge.name) {
    return res.status(403).json({ error: 'Signed participant information does not match the submitted information.' })
  }
  try {
    const signerAddress = verifyMessage(challenge.message, signature).toLowerCase()
    if (signerAddress !== challenge.adminAddress) {
      return res.status(403).json({ error: 'Signature is not from the authorized administrator.' })
    }
    const role = await rolesContract.DEFAULT_ADMIN_ROLE()
    if (!await rolesContract.hasRole(role, signerAddress)) {
      return res.status(403).json({ error: 'Admin permission no longer exists on-chain.' })
    }
    const normalized = getAddress(walletAddress).toLowerCase()
    await database.collection('participants').updateOne(
      { walletAddress: normalized },
      { $set: { name: cleaned, updatedAt: new Date(), chainId: Number(CHAIN_ID), contractAddress: CONTRACT_ADDRESS.toLowerCase() },
        $setOnInsert: { walletAddress: normalized, createdAt: new Date() } },
      { upsert: true }
    )
    res.json({ success: true, participant: { walletAddress: normalized, name: cleaned } })
  } catch (error) {
    console.error('Save participant:', error.message)
    res.status(500).json({ error: 'Could not save participant. Check the admin signature and database connection.' })
  }
})

// Upload a certificate PDF to Pinata. (Existing behavior preserved.)
app.post('/upload', (req, res, next) => {
  const origin = req.headers.origin

  if (!allowedOrigins.includes(origin)) {
    return res.status(403).json({
      error: 'Origin not allowed.'
    })
  }

  next()
}, upload.single('file'), async (req, res) => {
  try {
    const jwt = process.env.PINATA_JWT

    if (!jwt) {
      return res.status(500).json({
        error: 'PINATA_JWT is missing from the .env file.'
      })
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Please select a PDF file.'
      })
    }

    // Confirm the file begins with the PDF signature.
    const signature = req.file.buffer
      .subarray(0, 5)
      .toString()

    if (signature !== '%PDF-') {
      return res.status(400).json({
        error: 'Invalid PDF file.'
      })
    }

    const formData = new FormData()

    const pdf = new Blob(
      [req.file.buffer],
      { type: 'application/pdf' }
    )

    formData.append(
      'file',
      pdf,
      req.file.originalname
    )

    formData.append('network', 'public')

    const response = await fetch(
      'https://uploads.pinata.cloud/v3/files',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`
        },
        body: formData
      }
    )

    const result = await response.json()

    if (!response.ok) {
      console.error(
        'Pinata upload failed:',
        response.status,
        result
      )

      return res.status(502).json({
        error: 'Pinata rejected the upload. Check your JWT and permissions.'
      })
    }

    const cid = result.data?.cid

    if (!cid) {
      return res.status(502).json({
        error: 'Pinata did not return a CID.'
      })
    }

    console.log(
      'PDF uploaded successfully:',
      req.file.originalname
    )

    res.json({
      success: true,
      cid
    })

  } catch (error) {
    console.error('Upload error:', error.message)

    res.status(500).json({
      error: 'PDF upload failed.'
    })
  }
})

// Handle upload errors.
app.use((error, req, res, next) => {
  console.error('Request error:', error.message)

  res.status(400).json({
    error: error.message || 'Upload failed.'
  })
})

async function start() {
  try {
    // Check the ACTUAL remote chain ID, rather than trusting a static provider hint.
    const reportedChainId = BigInt(await chain.send('eth_chainId', []))
    if (reportedChainId !== CHAIN_ID) {
      throw new Error(`Sepolia RPC returned chain ID ${reportedChainId}; expected ${CHAIN_ID}.`)
    }
    const code = await chain.getCode(CONTRACT_ADDRESS)
    if (!code || code === '0x') {
      throw new Error('OrganicTrace contract was not found at the configured Sepolia address.')
    }
    console.log('Sepolia RPC verified (chain ID 11155111, contract available).')

    await connectMongoDB()

    app.listen(PORT, HOST, () => {
      console.log('----------------------------------------')
      console.log('OrganicTrace Sepolia + Pinata + MongoDB Server')
      console.log(`Running at http://${HOST}:${PORT}`)
      console.log('----------------------------------------')
    })
  } catch (error) {
    // Do not print the connection URI or database password.
    console.error('Backend startup failed:', error.message)
    console.error('Check SEPOLIA_RPC_URL, Sepolia access, MONGODB_URI, Atlas Network Access, and database permissions.')
    process.exitCode = 1
  }
}

async function shutdown() {
  if (mongoClient) await mongoClient.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

start()
