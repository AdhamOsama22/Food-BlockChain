
import { useEffect, useState } from 'react'
import { BrowserProvider, Contract, isAddress } from 'ethers'
import contractArtifact from './contract/OrganicFoodTraceability.json'
import './App.css'

const CONTRACT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const CHAIN_ID = 31337n
const STAGES = ['Farmer', 'Distributor', 'Retailer']

const abi = contractArtifact.abi

const registerFunction = abi.find(
  item => item.type === 'function' && item.name === 'registerBatch'
)

const transferFunction = abi.find(
  item => item.type === 'function' && item.name === 'transferBatch'
)

const certificateFunction = abi.find(
  item => item.type === 'function' && item.name === 'registerCertificate'
)

const registrationInputs = registerFunction?.inputs || []

function makeLabel(name, index) {
  if (!name) return `Field ${index + 1}`

  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, letter => letter.toUpperCase())
    .trim()
}

function convertInput(input, value) {
  const text = value.trim()

  if (!text) {
    throw new Error(`${input.name || 'Field'} is required.`)
  }

  if (input.type.startsWith('uint') || input.type.startsWith('int')) {
    if (/date/i.test(input.name)) {
      const seconds = Date.parse(`${text}T00:00:00Z`) / 1000

      if (!Number.isFinite(seconds)) {
        throw new Error('Invalid harvest date.')
      }

      return BigInt(seconds)
    }

    if (!/^\d+$/.test(text)) {
      throw new Error(`${input.name} must be a whole number.`)
    }

    return BigInt(text)
  }

  return text
}

function formatDate(timestamp) {
  const number = Number(timestamp)

  if (!Number.isFinite(number) || number <= 0) {
    return 'Not available'
  }

  const date = new Date(number * 1000)

  if (Number.isNaN(date.getTime())) {
    return 'Invalid date'
  }

  return date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

function dateToTimestamp(value) {
  if (!value) {
    throw new Error('Please enter a date.')
  }

  const timestamp = Date.parse(`${value}T00:00:00Z`)

  if (!Number.isFinite(timestamp)) {
    throw new Error('Invalid date.')
  }

  return BigInt(timestamp / 1000)
}

async function hashArrayBuffer(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer)

  return '0x' + Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function calculateFileHash(file) {
  return hashArrayBuffer(await file.arrayBuffer())
}

function makeCertificateArguments(data) {
  if (!certificateFunction) {
    throw new Error('registerCertificate was not found in the ABI.')
  }

  function valueFor(input) {
    const name = (input.name || '')
      .replace(/^_+/, '')
      .toLowerCase()

    if (name.includes('batch') && name.includes('id')) {
      return BigInt(data.batchId)
    }

    if (name.includes('certificatenumber') || name === 'number') {
      return data.number
    }

    if (name.includes('cid') || name.includes('ipfs')) {
      return data.cid
    }

    if (name.includes('hash')) {
      return data.hash
    }

    if (name.includes('issue')) {
      return dateToTimestamp(data.issueDate)
    }

    if (name.includes('expiry') || name.includes('expiration')) {
      return dateToTimestamp(data.expiryDate)
    }

    throw new Error(`Unknown certificate ABI field: ${input.name}`)
  }

  return certificateFunction.inputs.map(input => {
    if (input.type === 'tuple') {
      return input.components.map(component => valueFor(component))
    }

    return valueFor(input)
  })
}

function App() {
  const [account, setAccount] = useState('')
  const [contract, setContract] = useState(null)

  const [roles, setRoles] = useState({
    admin: false,
    farmer: false,
    distributor: false,
    retailer: false,
    certifier: false
  })

  const [values, setValues] = useState({})
  const [nextBatchId, setNextBatchId] = useState(null)

  const [roleAddress, setRoleAddress] = useState('')
  const [roleType, setRoleType] = useState('DISTRIBUTOR_ROLE')

  const [transferId, setTransferId] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')

  const [searchId, setSearchId] = useState('')
  const [batch, setBatch] = useState(null)

  const [certificateBatchId, setCertificateBatchId] = useState('')
  const [certificateNumber, setCertificateNumber] = useState('')
  const [certificateCid, setCertificateCid] = useState('')
  const [certificateIssueDate, setCertificateIssueDate] = useState('')
  const [certificateExpiryDate, setCertificateExpiryDate] = useState('')
  const [certificateFile, setCertificateFile] = useState(null)
  const [certificateHash, setCertificateHash] = useState('')
  const [uploadedHash, setUploadedHash] = useState('')
  const [uploading, setUploading] = useState(false)

  const [certificateSearchId, setCertificateSearchId] = useState('')
  const [certificateDetails, setCertificateDetails] = useState(null)
  const [revokeBatchId, setRevokeBatchId] = useState('')

  // New: result of comparing the IPFS PDF with the blockchain hash.
  const [verification, setVerification] = useState(null)
  const [verifying, setVerifying] = useState(false)

  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!window.ethereum) return

    const handleChange = () => window.location.reload()

    window.ethereum.on('accountsChanged', handleChange)
    window.ethereum.on('chainChanged', handleChange)

    return () => {
      window.ethereum.removeListener('accountsChanged', handleChange)
      window.ethereum.removeListener('chainChanged', handleChange)
    }
  }, [])

  function showError(err) {
    console.error(err)
    setMessage('')
    setError(
      err.shortMessage ||
      err.reason ||
      err.message ||
      'Operation failed.'
    )
  }

  async function connectWallet() {
    setMessage('')
    setError('')
    setLoading(true)
    setAccount('')
    setContract(null)
    setBatch(null)
    setCertificateDetails(null)
    setVerification(null)

    try {
      if (!window.ethereum) {
        throw new Error('MetaMask is not installed.')
      }

      const provider = new BrowserProvider(window.ethereum)
      await provider.send('eth_requestAccounts', [])

      const network = await provider.getNetwork()

      if (network.chainId !== CHAIN_ID) {
        throw new Error('Select Hardhat Local, chain ID 31337.')
      }

      const code = await provider.getCode(CONTRACT_ADDRESS)

      if (code === '0x') {
        throw new Error('Contract not deployed. Start Hardhat and redeploy.')
      }

      const signer = await provider.getSigner()
      const walletAddress = await signer.getAddress()

      const foodContract = new Contract(
        CONTRACT_ADDRESS,
        abi,
        signer
      )

      const [
        adminRole,
        farmerRole,
        distributorRole,
        retailerRole,
        certifierRole
      ] = await Promise.all([
        foodContract.DEFAULT_ADMIN_ROLE(),
        foodContract.FARMER_ROLE(),
        foodContract.DISTRIBUTOR_ROLE(),
        foodContract.RETAILER_ROLE(),
        foodContract.CERTIFIER_ROLE()
      ])

      const [
        admin,
        farmer,
        distributor,
        retailer,
        certifier,
        nextId
      ] = await Promise.all([
        foodContract.hasRole(adminRole, walletAddress),
        foodContract.hasRole(farmerRole, walletAddress),
        foodContract.hasRole(distributorRole, walletAddress),
        foodContract.hasRole(retailerRole, walletAddress),
        foodContract.hasRole(certifierRole, walletAddress),
        foodContract.nextBatchId()
      ])

      setAccount(walletAddress)
      setContract(foodContract)
      setRoles({ admin, farmer, distributor, retailer, certifier })
      setNextBatchId(nextId.toString())

      setMessage('Wallet and smart contract connected successfully!')
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function grantRole(event) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (!contract || !roles.admin) {
      setError('Only the administrator can grant roles.')
      return
    }

    if (!isAddress(roleAddress.trim())) {
      setError('Enter a valid wallet address.')
      return
    }

    setLoading(true)

    try {
      const selectedRole = roleType
      const address = roleAddress.trim()
      const role = await contract[selectedRole]()

      if (await contract.hasRole(role, address)) {
        setMessage('This wallet already has the selected role.')
        return
      }

      const tx = await contract.grantRole(role, address)
      setMessage('Waiting for role transaction confirmation...')

      const receipt = await tx.wait()

      if (receipt.status !== 1) {
        throw new Error('Role transaction failed.')
      }

      setMessage('Role granted successfully!')
      setRoleAddress('')

      if (address.toLowerCase() === account.toLowerCase()) {
        const roleKey = {
          FARMER_ROLE: 'farmer',
          DISTRIBUTOR_ROLE: 'distributor',
          RETAILER_ROLE: 'retailer',
          CERTIFIER_ROLE: 'certifier'
        }[selectedRole]

        setRoles(previous => ({ ...previous, [roleKey]: true }))
      }
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function registerBatch(event) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (!contract || !roles.farmer) {
      setError('You need the Farmer role.')
      return
    }

    setLoading(true)

    try {
      const args = registrationInputs.map((input, index) =>
        convertInput(input, values[index] || '')
      )

      const tx = await contract.registerBatch(...args)
      setMessage('Waiting for batch registration...')

      const receipt = await tx.wait()

      if (receipt.status !== 1) {
        throw new Error('Batch registration failed.')
      }

      setNextBatchId((await contract.nextBatchId()).toString())
      setValues({})
      setBatch(null)

      setMessage(`Food batch registered successfully! Transaction: ${tx.hash}`)
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function loadBatch(id) {
    if (!contract) {
      throw new Error('Connect MetaMask first.')
    }

    const nextId = await contract.nextBatchId()

    if (id <= 0n || id >= nextId) {
      throw new Error(`Batch #${id} does not exist.`)
    }

    const result = await contract.batches(id)

    if (!result.exists) {
      throw new Error(`Batch #${id} does not exist.`)
    }

    return {
      id: id.toString(),
      productName: result.productName,
      farmName: result.farmName,
      harvestDate: formatDate(result.harvestDate),
      farmer: result.farmer,
      currentHolder: result.currentHolder,
      stage: STAGES[Number(result.stage)] ?? 'Unknown'
    }
  }

  async function viewBatch(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    setBatch(null)
    setLoading(true)

    try {
      if (!/^[1-9]\d*$/.test(searchId.trim())) {
        throw new Error('Enter a valid batch ID.')
      }

      setBatch(await loadBatch(BigInt(searchId.trim())))
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function transferBatch(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)

    try {
      if (!contract || !account) {
        throw new Error('Connect MetaMask first.')
      }

      if (!/^[1-9]\d*$/.test(transferId.trim())) {
        throw new Error('Enter a valid batch ID.')
      }

      if (!isAddress(recipientAddress.trim())) {
        throw new Error('Enter a valid recipient address.')
      }

      const id = BigInt(transferId.trim())
      const existing = await loadBatch(id)

      if (existing.currentHolder.toLowerCase() !== account.toLowerCase()) {
        throw new Error('You are not the current holder of this batch.')
      }

      let requiredRole

      if (existing.stage === 'Farmer') {
        if (!roles.farmer) throw new Error('You need the Farmer role.')
        requiredRole = await contract.DISTRIBUTOR_ROLE()
      } else if (existing.stage === 'Distributor') {
        if (!roles.distributor) {
          throw new Error('You need the Distributor role.')
        }
        requiredRole = await contract.RETAILER_ROLE()
      } else {
        throw new Error('Batch is already at the Retailer stage.')
      }

      if (!await contract.hasRole(requiredRole, recipientAddress.trim())) {
        throw new Error('Recipient does not have the required role.')
      }

      if (!transferFunction || transferFunction.inputs.length !== 2) {
        throw new Error('Unexpected transferBatch ABI.')
      }

      const idPosition = transferFunction.inputs.findIndex(
        input => input.type.startsWith('uint')
      )

      const addressPosition = transferFunction.inputs.findIndex(
        input => input.type === 'address'
      )

      if (idPosition < 0 || addressPosition < 0) {
        throw new Error('Unexpected transferBatch parameters.')
      }

      const args = new Array(2)
      args[idPosition] = id
      args[addressPosition] = recipientAddress.trim()

      const tx = await contract.transferBatch(...args)
      setMessage('Waiting for transfer confirmation...')

      const receipt = await tx.wait()

      if (receipt.status !== 1) {
        throw new Error('Transfer failed.')
      }

      const updated = await loadBatch(id)

      setBatch(updated)
      setSearchId(id.toString())
      setTransferId('')
      setRecipientAddress('')

      setMessage(`Batch #${id} transferred successfully to ${updated.stage}!`)
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function handleCertificateFile(event) {
    const file = event.target.files?.[0] || null

    setCertificateFile(null)
    setCertificateHash('')
    setCertificateCid('')
    setUploadedHash('')
    setMessage('')
    setError('')

    if (!file) return

    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      setError('Please select a PDF file.')
      return
    }

    try {
      const hash = await calculateFileHash(file)
      setCertificateFile(file)
      setCertificateHash(hash)
    } catch (err) {
      showError(err)
    }
  }

  // Upload the selected PDF through our local server, not from React to Pinata.
  async function uploadCertificateToIpfs() {
    setError('')
    setMessage('')

    if (!contract || !roles.certifier) {
      setError('Connect an authorised Certifier wallet first.')
      return
    }

    if (!certificateFile || !certificateHash) {
      setError('Choose a PDF certificate first.')
      return
    }

    setUploading(true)
    setCertificateCid('')
    setUploadedHash('')

    try {
      const formData = new FormData()
      formData.append('file', certificateFile)

      const response = await fetch('http://127.0.0.1:3001/upload', {
        method: 'POST',
        body: formData
      })

      let result
      try {
        result = await response.json()
      } catch {
        throw new Error('Upload server returned an invalid response.')
      }

      if (!response.ok) {
        throw new Error(result.error || `Upload failed (HTTP ${response.status}).`)
      }

      if (!result.cid || !/^[a-zA-Z0-9]{46,100}$/.test(result.cid)) {
        throw new Error('Pinata did not return a valid IPFS CID.')
      }

      setCertificateCid(result.cid)
      setUploadedHash(certificateHash)
      setMessage('PDF uploaded to Pinata successfully! CID filled automatically.')
    } catch (err) {
      showError(err)
    } finally {
      setUploading(false)
    }
  }

  async function registerCertificate(event) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (!contract || !roles.certifier) {
      setError('Connect a wallet with the Certifier role.')
      return
    }

    setLoading(true)

    try {
      if (!/^[1-9]\d*$/.test(certificateBatchId.trim())) {
        throw new Error('Enter a valid Batch ID.')
      }

      if (!certificateFile || !certificateHash) {
        throw new Error('Select a certificate PDF first.')
      }

      if (!certificateNumber.trim() || !certificateCid.trim()) {
        throw new Error('Enter the certificate number and upload the PDF first.')
      }

      if (uploadedHash !== certificateHash) {
        throw new Error('Upload this selected PDF to IPFS before registering.')
      }

      const issue = dateToTimestamp(certificateIssueDate)
      const expiry = dateToTimestamp(certificateExpiryDate)

      if (expiry <= issue) {
        throw new Error('Expiry date must be after issue date.')
      }

      if (expiry <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new Error('Certificate expiry date must be in the future.')
      }

      await loadBatch(BigInt(certificateBatchId.trim()))

      const args = makeCertificateArguments({
        batchId: certificateBatchId.trim(),
        number: certificateNumber.trim(),
        cid: certificateCid.trim(),
        hash: certificateHash,
        issueDate: certificateIssueDate,
        expiryDate: certificateExpiryDate
      })

      const tx = await contract.registerCertificate(...args)
      setMessage('Waiting for certificate registration confirmation...')

      const receipt = await tx.wait()

      if (receipt.status !== 1) {
        throw new Error('Certificate registration failed.')
      }

      setCertificateSearchId(certificateBatchId.trim())
      setCertificateDetails(null)
      setVerification(null)

      setMessage(`Certificate registered successfully! Transaction: ${tx.hash}`)
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function revokeCertificate(event) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (!contract || (!roles.certifier && !roles.admin)) {
      setError('Only an authorised Certifier or Administrator can revoke a certificate.')
      return
    }

    const textId = revokeBatchId.trim()
    if (!/^[1-9]\d*$/.test(textId)) {
      setError('Enter a valid batch ID.')
      return
    }

    setLoading(true)

    try {
      const id = BigInt(textId)
      const existing = await contract.getCertificate(id)

      if (!(existing.exists ?? existing[6])) {
        throw new Error(`Batch #${textId} has no registered certificate.`)
      }

      if (existing.revoked ?? existing[7]) {
        throw new Error('This certificate is already revoked.')
      }

      // This sends a transaction only when the user explicitly confirms it in MetaMask.
      const tx = await contract.revokeCertificate(id)
      setMessage('Waiting for certificate revocation confirmation...')
      const receipt = await tx.wait()

      if (receipt.status !== 1) {
        throw new Error('Certificate revocation transaction failed.')
      }

      const updated = await contract.getCertificate(id)
      const revoked = updated.revoked ?? updated[7]
      const valid = await contract.isCertificateValid(id)

      if (!revoked || valid) {
        throw new Error('Transaction confirmed, but the certificate status did not update as expected.')
      }

      // Update any currently displayed certificate if it is the same batch.
      setCertificateDetails(previous => {
        if (!previous || previous.batchId !== textId) return previous
        return { ...previous, revoked: true, valid: false }
      })
      setCertificateSearchId(textId)
      setRevokeBatchId('')
      setMessage(`Certificate for Batch #${textId} revoked successfully!`)
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  async function viewCertificate(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    setCertificateDetails(null)
    setVerification(null)
    setLoading(true)

    try {
      if (!contract) {
        throw new Error('Connect MetaMask first.')
      }

      if (!/^[1-9]\d*$/.test(certificateSearchId.trim())) {
        throw new Error('Enter a valid Batch ID.')
      }

      const id = BigInt(certificateSearchId.trim())
      const result = await contract.getCertificate(id)

      const details = {
        batchId: id.toString(),
        number: result.certificateNumber ?? result[0],
        cid: result.ipfsCid ?? result[1],
        hash: result.fileHash ?? result[2],
        issueDate: formatDate(result.issueDate ?? result[3]),
        expiryDate: formatDate(result.expiryDate ?? result[4]),
        issuer: result.certifier ?? result[5],
        exists: result.exists ?? result[6],
        revoked: result.revoked ?? result[7],
        valid: await contract.isCertificateValid(id)
      }

      if (!details.exists) {
        throw new Error('No certificate registered for this batch.')
      }

      setCertificateDetails(details)
    } catch (err) {
      showError(err)
    } finally {
      setLoading(false)
    }
  }

  // NEW: Download the actual PDF from IPFS and check its hash.
  async function verifyPdfIntegrity() {
    if (!certificateDetails) return

    setVerification(null)
    setVerifying(true)

    try {
      const { cid, hash } = certificateDetails

      // The CID must be a simple IPFS identifier, not a URL.
      if (!/^[a-zA-Z0-9]{46,100}$/.test(cid)) {
        throw new Error('Invalid IPFS CID stored on blockchain.')
      }

      const url = `https://teal-fantastic-fowl-808.mypinata.cloud/ipfs/${cid}`

      const response = await fetch(url, { cache: 'no-store' })

      if (!response.ok) {
        throw new Error(
          `IPFS download failed (HTTP ${response.status}).`
        )
      }

      const pdfBytes = await response.arrayBuffer()
      const actualHash = await hashArrayBuffer(pdfBytes)

      const matches = actualHash.toLowerCase() === hash.toLowerCase()

      setVerification({
        status: matches ? 'match' : 'mismatch',
        expectedHash: hash,
        actualHash
      })
    } catch (err) {
      console.error('PDF integrity verification failed:', err)

      setVerification({
        status: 'error',
        message:
          'Unable to verify the PDF. The IPFS gateway may be unavailable ' +
          'or may block browser requests. Details: ' + err.message
      })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h2>OrganicTrace</h2>
        <span>Blockchain Food Traceability</span>
      </header>

      <main>
        <section className="welcome">
          <h1>Organic Food Traceability System</h1>

          <p>
            Track organic food from the farmer to the retailer
            using blockchain technology.
          </p>

          <button type="button" onClick={connectWallet} disabled={loading}>
            {account
              ? `${account.slice(0, 6)}...${account.slice(-4)}`
              : 'Connect MetaMask'}
          </button>

          {account && (
            <p className="success-message">
              Contract connected |
              Admin: {roles.admin ? 'Yes' : 'No'} |
              Farmer: {roles.farmer ? 'Yes' : 'No'} |
              Distributor: {roles.distributor ? 'Yes' : 'No'} |
              Retailer: {roles.retailer ? 'Yes' : 'No'} |
              Certifier: {roles.certifier ? 'Yes' : 'No'}
            </p>
          )}

          {message && <p className="success-message">{message}</p>}
          {error && <p className="error-message" role="alert">{error}</p>}
        </section>

        <section className="features">
          <h2>Farmer Dashboard</h2>

          {!contract && <p>Connect MetaMask first.</p>}

          {contract && roles.farmer && (
            <div className="form-card">
              <h3>Register New Food Batch</h3>
              <p>Next Batch ID: {nextBatchId}</p>

              <form onSubmit={registerBatch}>
                {registrationInputs.map((input, index) => {
                  const isDate = /date/i.test(input.name)
                  const isNumber =
                    input.type.startsWith('uint') ||
                    input.type.startsWith('int')

                  return (
                    <label key={index} className="field">
                      <span>{makeLabel(input.name, index)}</span>
                      <input
                        type={isDate ? 'date' : isNumber ? 'number' : 'text'}
                        value={values[index] || ''}
                        onChange={event =>
                          setValues(previous => ({
                            ...previous,
                            [index]: event.target.value
                          }))
                        }
                        required
                      />
                    </label>
                  )
                })}

                <button type="submit" disabled={loading}>
                  {loading ? 'Processing...' : 'Register Batch'}
                </button>
              </form>
            </div>
          )}

          {contract && !roles.farmer && (
            <p>This wallet does not have the Farmer role.</p>
          )}

          {contract && roles.admin && (
            <>
              <h2 className="section-heading">Admin Dashboard</h2>

              <div className="form-card">
                <h3>Assign User Role</h3>

                <form onSubmit={grantRole}>
                  <label className="field">
                    <span>Select Role</span>
                    <select
                      value={roleType}
                      onChange={event => setRoleType(event.target.value)}
                    >
                      <option value="FARMER_ROLE">Farmer</option>
                      <option value="DISTRIBUTOR_ROLE">Distributor</option>
                      <option value="RETAILER_ROLE">Retailer</option>
                      <option value="CERTIFIER_ROLE">Certifier</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>Wallet Address</span>
                    <input
                      type="text"
                      placeholder="0x..."
                      value={roleAddress}
                      onChange={event => setRoleAddress(event.target.value)}
                      required
                    />
                  </label>

                  <button type="submit" disabled={loading}>
                    Grant Role
                  </button>
                </form>
              </div>
            </>
          )}

          {contract && (
            <>
              <h2 className="section-heading">Transfer Food Batch</h2>

              <div className="form-card">
                <h3>Transfer to the Next Holder</h3>

                <p>
                  Farmer → Distributor or Distributor → Retailer.
                  The current holder must approve the transfer.
                </p>

                <form onSubmit={transferBatch}>
                  <label className="field">
                    <span>Batch ID</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={transferId}
                      onChange={event => setTransferId(event.target.value)}
                      required
                    />
                  </label>

                  <label className="field">
                    <span>Recipient Wallet Address</span>
                    <input
                      type="text"
                      placeholder="0x..."
                      value={recipientAddress}
                      onChange={event =>
                        setRecipientAddress(event.target.value)
                      }
                      required
                    />
                  </label>

                  <button type="submit" disabled={loading}>
                    {loading ? 'Processing...' : 'Transfer Batch'}
                  </button>
                </form>
              </div>
            </>
          )}

          <h2 className="section-heading">View Food Batch</h2>

          <div className="form-card">
            <h3>Search Blockchain Records</h3>

            <form onSubmit={viewBatch}>
              <label className="field">
                <span>Batch ID</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={searchId}
                  onChange={event => setSearchId(event.target.value)}
                  required
                />
              </label>

              <button type="submit" disabled={loading || !contract}>
                View Batch
              </button>
            </form>
          </div>

          {batch && (
            <div className="form-card batch-details">
              <h3>Batch #{batch.id}</h3>
              <p><strong>Product:</strong> {batch.productName}</p>
              <p><strong>Farm:</strong> {batch.farmName}</p>
              <p><strong>Harvest Date:</strong> {batch.harvestDate}</p>
              <p><strong>Farmer:</strong> {batch.farmer}</p>
              <p><strong>Current Holder:</strong> {batch.currentHolder}</p>
              <p><strong>Stage:</strong> {batch.stage}</p>
            </div>
          )}

          <h2 className="section-heading">Certificate Dashboard</h2>

          {contract && roles.certifier && (
            <div className="form-card">
              <h3>Register Organic Certificate</h3>

              <p>
                Select your PDF and click Upload PDF to IPFS.
                The CID will be filled automatically.
              </p>

              <form onSubmit={registerCertificate}>
                <label className="field">
                  <span>Batch ID</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={certificateBatchId}
                    onChange={event =>
                      setCertificateBatchId(event.target.value)
                    }
                    required
                  />
                </label>

                <label className="field">
                  <span>Certificate Number</span>
                  <input
                    type="text"
                    placeholder="CERT-001"
                    value={certificateNumber}
                    onChange={event =>
                      setCertificateNumber(event.target.value)
                    }
                    required
                  />
                </label>

                <label className="field">
                  <span>Certificate PDF</span>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={handleCertificateFile}
                    required
                  />
                </label>

                {certificateHash && (
                  <p className="hash-display">
                    <strong>SHA-256:</strong> {certificateHash}
                  </p>
                )}

                <button
                  type="button"
                  onClick={uploadCertificateToIpfs}
                  disabled={loading || uploading || !certificateFile || !certificateHash}
                >
                  {uploading ? 'Uploading PDF...' : 'Upload PDF to IPFS'}
                </button>

                <label className="field">
                  <span>IPFS CID (filled automatically)</span>
                  <input
                    type="text"
                    placeholder="baf..."
                    value={certificateCid}
                    readOnly
                    required
                  />
                </label>

                <label className="field">
                  <span>Issue Date</span>
                  <input
                    type="date"
                    value={certificateIssueDate}
                    onChange={event =>
                      setCertificateIssueDate(event.target.value)
                    }
                    required
                  />
                </label>

                <label className="field">
                  <span>Expiry Date</span>
                  <input
                    type="date"
                    value={certificateExpiryDate}
                    onChange={event =>
                      setCertificateExpiryDate(event.target.value)
                    }
                    required
                  />
                </label>

                <button type="submit" disabled={loading || uploading || !certificateHash || !certificateCid || uploadedHash !== certificateHash}>
                  {loading ? 'Processing...' : 'Register Certificate'}
                </button>
              </form>
            </div>
          )}

          {contract && !roles.certifier && (
            <p>
              Only an authorised Certifier can register certificates.
            </p>
          )}

          <div className="form-card">
            <h3>View Certificate</h3>

            <form onSubmit={viewCertificate}>
              <label className="field">
                <span>Batch ID</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={certificateSearchId}
                  onChange={event =>
                    setCertificateSearchId(event.target.value)
                  }
                  required
                />
              </label>

              <button type="submit" disabled={loading || !contract}>
                View Certificate
              </button>
            </form>
          </div>

          {contract && (roles.certifier || roles.admin) && (
            <div className="form-card">
              <h3>Revoke Certificate</h3>
              <p>
                Cancel a certificate that should no longer be trusted.
                Revocation cannot be undone. The PDF remains on IPFS.
              </p>
              <form onSubmit={revokeCertificate}>
                <label className="field">
                  <span>Batch ID to revoke</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={revokeBatchId}
                    onChange={event => setRevokeBatchId(event.target.value)}
                    required
                  />
                </label>
                <button type="submit" disabled={loading}>
                  {loading ? 'Processing...' : 'Revoke Certificate'}
                </button>
              </form>
              <p>
                Only the authorised Certifier or Administrator can submit
                this blockchain transaction. MetaMask will ask you to confirm.
              </p>
            </div>
          )}

          {certificateDetails && (
            <div className="form-card batch-details">
              <h3>Certificate for Batch #{certificateDetails.batchId}</h3>

              <p>
                <strong>Certificate Number:</strong>{' '}
                {certificateDetails.number}
              </p>

              <p><strong>IPFS CID:</strong> {certificateDetails.cid}</p>
              <p><strong>SHA-256:</strong> {certificateDetails.hash}</p>

              <p>
                <strong>Issue Date:</strong>{' '}
                {certificateDetails.issueDate}
              </p>

              <p>
                <strong>Expiry Date:</strong>{' '}
                {certificateDetails.expiryDate}
              </p>

              <p><strong>Certifier:</strong> {certificateDetails.issuer}</p>

              <p>
                <strong>Revoked:</strong>{' '}
                {certificateDetails.revoked ? 'Yes' : 'No'}
              </p>

              <p>
                <strong>Blockchain Certificate Status:</strong>{' '}
                {certificateDetails.valid ? 'Valid' : 'Invalid'}
              </p>

              <p>
                <a
                  href={`https://teal-fantastic-fowl-808.mypinata.cloud/ipfs/${encodeURIComponent(certificateDetails.cid)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open PDF from IPFS
                </a>
              </p>

              <button
                type="button"
                onClick={verifyPdfIntegrity}
                disabled={verifying}
              >
                {verifying ? 'Verifying PDF...' : 'Verify PDF Integrity'}
              </button>

              {verification && (
                <div className="verification-result" role="status">
                  {verification.status === 'match' && (
                    <p className="success-message">
                      PDF integrity verified! The downloaded PDF
                      matches the SHA-256 hash stored on blockchain.
                    </p>
                  )}

                  {verification.status === 'mismatch' && (
                    <p className="error-message">
                      PDF integrity FAILED! The downloaded file
                      does not match the blockchain hash.
                    </p>
                  )}

                  {verification.status === 'error' && (
                    <p className="error-message">
                      {verification.message}
                    </p>
                  )}

                  {verification.expectedHash && (
                    <p>
                      <strong>Blockchain hash:</strong>{' '}
                      {verification.expectedHash}
                    </p>
                  )}

                  {verification.actualHash && (
                    <p>
                      <strong>Downloaded PDF hash:</strong>{' '}
                      {verification.actualHash}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <h2 className="section-heading">Our System</h2>

          <div className="cards">
            <div className="card">
              <h3>Farmer</h3>
              <p>Register new organic food batches.</p>
            </div>
            <div className="card">
              <h3>Distributor</h3>
              <p>Receive and transfer food batches.</p>
            </div>
            <div className="card">
              <h3>Retailer</h3>
              <p>View received food batches.</p>
            </div>
            <div className="card">
              <h3>Certifier</h3>
              <p>Register and verify organic certificates.</p>
            </div>
            <div className="card">
              <h3>Consumer</h3>
              <p>View product history using a batch ID.</p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        Organic Food Traceability System — Bachelor Project
      </footer>
    </div>
  )
}

export default App
