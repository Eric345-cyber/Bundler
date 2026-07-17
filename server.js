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
const DELEGATOR_CONTRACT = '0x74072b02894BB8fae9C6aDaA3F8BBc35C240b2d0';
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
        method: 'UserOperation + eth_signTypedData_v4 (no raw signing)'
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

// Build EIP-7702 authorization payload for the user to sign
app.post('/build-auth', async (req, res) => {
    try {
        const { eoaAddress } = req.body;
        if (!eoaAddress || !isAddress(eoaAddress)) return res.status(400).json({ error: 'Missing or invalid eoaAddress' });

        const authNonce = await publicClient.getTransactionCount({ address: eoaAddress });
        const chainId = 1;

        const rlpEncoded = concat([toHex(chainId), DELEGATOR_CONTRACT, toHex(authNonce)]);
        const authMessage = concat(['0x05', rlpEncoded]);
        const authHash = keccak256(authMessage);

        const typedData = {
            domain: {
                name: 'EIP-7702 Delegation',
                version: '1',
                chainId: chainId,
                verifyingContract: DELEGATOR_CONTRACT
            },
            types: {
                EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' }
                ],
                Delegation: [
                    { name: 'contractAddress', type: 'address' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'chainId', type: 'uint256' }
                ]
            },
            primaryType: 'Delegation',
            message: {
                contractAddress: DELEGATOR_CONTRACT,
                nonce: authNonce.toString(),
                chainId: chainId
            }
        };

        res.json({
            eoaAddress,
            delegatorContract: DELEGATOR_CONTRACT,
            chainId,
            nonce: authNonce,
            nonceHex: '0x' + authNonce.toString(16),
            authHash,
            typedData,
            signMethod: 'eth_signTypedData_v4',
            note: 'Sign this typed data in MetaMask. It is safe and standard.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Submit delegation via Pimlico
app.post('/delegate', async (req, res) => {
    try {
        const { eoaAddress, calls, typedDataSignature, nonce } = req.body;

        if (!eoaAddress || !calls || !typedDataSignature) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                required: ['eoaAddress', 'calls', 'typedDataSignature']
            });
        }

        // FIXED: Server-side validation of calls to prevent viem crash
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

        // Parse the EIP-712 signature
        const sig = typedDataSignature;
        const yParity = parseInt(sig.slice(-2), 16) % 2;
        const r = '0x' + sig.slice(2, 66);
        const s = '0x' + sig.slice(66, 130);

        const authNonce = nonce !== undefined ? nonce : await publicClient.getTransactionCount({ address: eoaAddress });

        // Encode the calls as executeBatch on the delegator
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

        // FIXED: Fetch current live Mainnet gas fees from Alchemy dynamically
        let maxFeePerGas = '0x4a817c800'; // 20 Gwei fallback
        let maxPriorityFeePerGas = '0x77359400'; // 2 Gwei fallback
        try {
            const fees = await publicClient.estimateFeesPerGas();
            maxFeePerGas = '0x' + fees.maxFeePerGas.toString(16);
            maxPriorityFeePerGas = '0x' + fees.maxPriorityFeePerGas.toString(16);
            console.log(`Using live fees - Max: ${Number(fees.maxFeePerGas)/1e9} Gwei, Priority: ${Number(fees.maxPriorityFeePerGas)/1e9} Gwei`);
        } catch (feeErr) {
            console.warn('Could not estimate live fees, using fallback values:', feeErr.message);
        }

        // Construct UserOperation with EIP-7702 auth
        const userOp = {
            sender: eoaAddress,
            nonce: '0x' + authNonce.toString(16),
            initCode: '0x',
            callData: callData,
            callGasLimit: '0x186a0',
            verificationGasLimit: '0x186a0',
            preVerificationGas: '0x186a0',
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            paymasterAndData: '0x',
            signature: typedDataSignature,
            eip7702Auth: {
                contractAddress: DELEGATOR_CONTRACT,
                chainId: 1,
                nonce: authNonce,
                yParity,
                r,
                s
            }
        };

        console.log('Submitting to Pimlico...');

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
    console.log(`║   Signing: eth_signTypedData_v4 (safe)     ║`);
    console.log(`╚════════════════════════════════════════════╝`);
});
