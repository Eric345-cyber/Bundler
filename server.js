const express = require('express');
const cors = require('cors');
const { createPublicClient, http, toHex, keccak256, concat, encodeFunctionData, isAddress } = require('viem');
const { mainnet } = require('viem/chains');

const app = express();
app.use(cors());
app.use(express.json());

// Config
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY || 'pim_azP7VD5oAzBi25htQxZmUu';
const ALCHEMY_RPC = process.env.ALCHEMY_RPC || 'https://eth-mainnet.g.alchemy.com/v2/J71uV3kbMEPPRpavbEiQa';
// Live deployed Mainnet contract address
const DELEGATOR_CONTRACT = '0x1e04D61835f262d11C37524eb1b9829c4A708c35'; 
const PORT = process.env.PORT || 3000;

const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(ALCHEMY_RPC),
});

// FIXED: Routing to "ethereum" instead of "mainnet" to satisfy Pimlico
const pimlicoRpc = `https://api.pimlico.io/v2/ethereum/rpc?apikey=${PIMLICO_API_KEY}`;

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'EIP-7702 Relayer Online', 
        contract: DELEGATOR_CONTRACT,
        network: 'mainnet',
        method: 'UserOperation + wallet_signAuthorization (native signatures)'
    });
});

// Get account info
app.post('/get-account-info', async (req, res) => {
    try {
        const { eoaAddress } = req.body;
        if (!eoaAddress || !isAddress(eoaAddress)) {
            return res.status(400).json({ error: 'Invalid EOA address' });
        }

        const nonce = await publicClient.getTransactionCount({ address: eoaAddress, blockTag: 'latest' });
        const balance = await publicClient.getBalance({ address: eoaAddress });

        res.json({ 
            eoaAddress,
            nonce,
            nonceHex: '0x' + nonce.toString(16),
            balance: balance.toString(),
            balanceEth: (Number(balance) / 1e18).toFixed(6),
            delegatorContract: DELEGATOR_CONTRACT,
            chainId: 1
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Build EIP-7702 authorization payload details
app.post('/build-auth', async (req, res) => {
    try {
        const { eoaAddress } = req.body;
        if (!eoaAddress || !isAddress(eoaAddress)) return res.status(400).json({ error: 'Missing or invalid eoaAddress' });

        const authNonce = await publicClient.getTransactionCount({ address: eoaAddress });
        const chainId = 1;

        res.json({
            eoaAddress,
            delegatorContract: DELEGATOR_CONTRACT,
            chainId,
            nonce: authNonce,
            nonceHex: '0x' + authNonce.toString(16),
            note: 'Fetch info completed. Sign using wallet_signAuthorization.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Submit delegation via Pimlico
app.post('/delegate', async (req, res) => {
    try {
        const { eoaAddress, calls, authorization, nonce } = req.body;

        if (!eoaAddress || !calls || !authorization) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['eoaAddress', 'calls', 'authorization']
            });
        }

        // Validate calls array
        if (!Array.isArray(calls) || calls.length === 0) {
            return res.status(400).json({ error: 'Calls list cannot be empty' });
        }

        for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            if (!call.to || !isAddress(call.to.trim())) {
                return res.status(400).json({ 
                    error: `Invalid target address in call at index ${i}. Must be a valid 20-byte hex address.` 
                });
            }
        }

        console.log('Delegation request verified:', { eoaAddress, callsCount: calls.length });

        // Fetch EOA Transaction Count for safety checks
        const authNonce = nonce !== undefined ? nonce : await publicClient.getTransactionCount({ address: eoaAddress });

        // Query the EntryPoint contract directly to fetch expected UserOperation nonce (starts at 0)
        const entryPointAbi = [
            {
                name: 'getNonce',
                type: 'function',
                stateMutability: 'view',
                inputs: [
                    { name: 'sender', type: 'address' },
                    { name: 'key', type: 'uint192' }
                ],
                outputs: [{ name: 'nonce', type: 'uint256' }]
            }
        ];

        let entryPointNonce = 0n;
        try {
            entryPointNonce = await publicClient.readContract({
                address: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
                abi: entryPointAbi,
                functionName: 'getNonce',
                args: [eoaAddress, 0n] // key is 0 for standard sequential nonces
            });
            console.log(`Fetched EntryPoint nonce: ${entryPointNonce.toString()}`);
        } catch (nonceErr) {
            console.warn("Failed to fetch EntryPoint nonce, defaulting to 0:", nonceErr.message);
        }

        // Encode the batch calls
        const callData = encodeFunctionData({
            abi: [{
                name: 'executeBatch',
                type: 'function',
                inputs: [
                    { name: 'targets', type: 'address[]' },
                    { name: 'values', type: 'uint256[]' },
                    { name: 'datas', type: 'bytes[]' }
                ]
            }],
            args: [
                calls.map(c => c.to.trim()),
                calls.map(c => BigInt(c.value || '0')),
                calls.map(c => c.data || '0x')
            ]
        });

        // Fetch current live Mainnet gas fees dynamically
        let maxFeePerGas = '0x4a817c800'; 
        let maxPriorityFeePerGas = '0x77359400'; 
        try {
            const fees = await publicClient.estimateFeesPerGas();
            maxFeePerGas = '0x' + fees.maxFeePerGas.toString(16);
            maxPriorityFeePerGas = '0x' + fees.maxPriorityFeePerGas.toString(16);
            console.log(`Live fees evaluated - Max: ${Number(fees.maxFeePerGas)/1e9} Gwei, Priority: ${Number(fees.maxPriorityFeePerGas)/1e9} Gwei`);
        } catch (feeErr) {
            console.warn('Could not estimate live fees, using fallback values:', feeErr.message);
        }

        // Construct UserOperation with the CORRECT native signature parameters
        const userOp = {
            sender: eoaAddress,
            nonce: '0x' + entryPointNonce.toString(16), 
            initCode: '0x',
            callData: callData,
            callGasLimit: '0x186a0',
            verificationGasLimit: '0x186a0',
            preVerificationGas: '0x186a0',
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            paymasterAndData: '0x',
            signature: '0x', // Bypassed signature verification in contract, so dummy value works
            eip7702Auth: {
                contractAddress: authorization.contractAddress,
                chainId: parseInt(authorization.chainId, 16),
                nonce: parseInt(authorization.nonce, 16),
                yParity: parseInt(authorization.yParity, 16),
                r: authorization.r,
                s: authorization.s
            }
        };

        console.log('Submitting payload to Pimlico...');

        const response = await fetch(pimlicoRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_sendUserOperation',
                params: [userOp, '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789']
            })
        });

        const result = await response.json();
        console.log('Pimlico response:', result);

        if (result.error) {
            return res.status(400).json({
                error: 'Bundler rejected UserOperation',
                details: result.error
            });
        }

        res.json({
            success: true,
            userOpHash: result.result,
            eoaAddress,
            delegatorContract: DELEGATOR_CONTRACT,
            note: 'UserOperation submitted. Polling required for confirmation.'
        });

    } catch (err) {
        console.error('Delegation error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Check UserOperation status
app.post('/status', async (req, res) => {
    try {
        const { userOpHash } = req.body;

        const response = await fetch(pimlicoRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getUserOperationReceipt',
                params: [userOpHash]
            })
        });

        const result = await response.json();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`╔════════════════════════════════════════════╗`);
    console.log(`║   EIP-7702 Relayer Online                  ║`);
    console.log(`║   Port: ${PORT}                              ║`);
    console.log(`║   Contract: ${DELEGATOR_CONTRACT.slice(0, 20)}...      ║`);
    console.log(`║   Signing: wallet_signAuthorization (native)║`);
    console.log(`╚════════════════════════════════════════════╝`);
});
