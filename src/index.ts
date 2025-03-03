import {
  Connection,
  Transaction,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import {
  AccountLayout,
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { TokenAsset, WalletBalanceChange , simulateVersionedTransactionWithBalanceChanges , fetchTokenInfo} from './versioned';


interface TransactionInfo {
  account: string; // This will hold the wallet public key (owner), not the token account
  assets: TokenAsset;
}

async function simulateTransactionWithBalanceChanges(
  serializedTransaction: string,
  connection: Connection
) {
  // Convert Base64 to Transaction
  const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
  const transaction = Transaction.from(transactionBuffer);
  
  // Get the accounts involved in the transaction
  const accounts = transaction.instructions.flatMap(ix => 
    ix.keys.map(key => key.pubkey)
  );
  const uniqueAccounts = [...new Set(accounts.map(acc => acc.toBase58()))];
  
  // Get the first signer's wallet address (typically the user's wallet)
  const firstSignerWallet = transaction.signatures[0]?.publicKey.toBase58();
  //console.log(`First signer wallet: ${firstSignerWallet}`);
  
  // Track SOL balances and token balances
  const preBalances = new Map();
  
  // Get SOL balance for the first signer
  if (firstSignerWallet) {
    try {
      const solBalance = await connection.getBalance(new PublicKey(firstSignerWallet));
      preBalances.set(`SOL:${firstSignerWallet}`, {
        mint: 'So11111111111111111111111111111111111111112',
        amount: solBalance,
        owner: firstSignerWallet
      });
    } catch (error : any) {
      console.log(`Error fetching SOL balance: ${error.message}`);
    }
  }
  
  // Get pre-simulation token balances 
  for (const accountAddress of uniqueAccounts) {
    const pubkey = new PublicKey(accountAddress);
    try {
      const accountInfo = await connection.getAccountInfo(pubkey);
      
      // Check if this is a token account
      if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length === ACCOUNT_SIZE) {
        const decoded = AccountLayout.decode(accountInfo.data);
        const mint = decoded.mint.toString();
        const amount = Number(decoded.amount);
        const owner = decoded.owner.toString(); 
        
        // Only track token accounts owned by the first signer
        if (owner === firstSignerWallet) {
          preBalances.set(`${mint}:${accountAddress}`, { mint, amount, owner, tokenAccount: accountAddress })
        }
      }
    } catch (error : any) {
      console.log(`Error fetching account ${accountAddress}: ${error.message}`);
    }
  }
  
  // Simulate the transaction
  console.log('Simulating transaction...');
  const simulationResult = await connection.simulateTransaction(transaction, undefined, true);
  
  if (!simulationResult.value.accounts) {
    console.log('Simulation did not return account information');
    return { success: simulationResult.value.err === null };
  }
  
  // Extract post-simulation token balances
  const postBalances = new Map();
  
  // Find the signer's SOL account in the simulation results
  if (firstSignerWallet) {
    const signerAccountIndex = 0;
    
    if (signerAccountIndex >= 0 && simulationResult.value.accounts[signerAccountIndex]) {
      const postSolBalance = BigInt(simulationResult.value.accounts[signerAccountIndex].lamports || 0);
      
      postBalances.set(`SOL:${firstSignerWallet}`, {
        mint: 'So11111111111111111111111111111111111111112',
        amount: Number(postSolBalance),
        owner: firstSignerWallet
      });
    }
  }
  
  // Extract token balances from simulation results
  for (let i = 0; i < simulationResult.value.accounts.length; i++) {
    const account = simulationResult.value.accounts[i];
    
    if (!account) continue;
    
    // Extract the account address from the transaction
    const accountPubkey = uniqueAccounts[i];
    
    // Check if it's a token account
    if (account.owner === TOKEN_PROGRAM_ID.toBase58()) {
      try {
        const data = Buffer.from(account.data[0], 'base64');
        
        // Verify it's actually a token account by checking size
        if (data.length === ACCOUNT_SIZE) {
          const decoded = AccountLayout.decode(data);
          const mint = decoded.mint.toString();
          const amount = Number(decoded.amount);
          const owner = decoded.owner.toString();
          
          // Only track token accounts owned by the first signer
          if (owner === firstSignerWallet) {
            postBalances.set(`${mint}:${accountPubkey}`, { mint, amount, owner, tokenAccount: accountPubkey });
          }
        }
      } catch (error : any) {
        console.log(`Error decoding account data: ${error.message}`);
      }
    }
  }
  
  // Calculate balance changes
  const tokensBought = [];
  const tokensSold = [];
  
  // Process SOL balance changes
  const preSolBalance = preBalances.get(`SOL:${firstSignerWallet}`)?.amount || 0;
  const postSolBalance = postBalances.get(`SOL:${firstSignerWallet}`)?.amount || 0;
  
  if (preSolBalance !== postSolBalance) {
    const solBalanceChange = postSolBalance - preSolBalance;
    const tokenInfo = await fetchTokenInfo('So11111111111111111111111111111111111111112');
    
    if (solBalanceChange > 0) {
      // Bought SOL
      tokensBought.push({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        amount: solBalanceChange / LAMPORTS_PER_SOL,
        rawAmount: solBalanceChange,
        decimals: tokenInfo.decimals,
        logouri: tokenInfo.logouri
      });
    } else if (solBalanceChange < 0) {
      // Sold SOL
      tokensSold.push({
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        amount: Math.abs(solBalanceChange) / LAMPORTS_PER_SOL,
        rawAmount: Math.abs(solBalanceChange),
        decimals: tokenInfo.decimals,
        logouri: tokenInfo.logouri
      });
    }
  }
  
  // Create a map to group token accounts by mint
  const preMintTotals = new Map();
  const postMintTotals = new Map();
  
  // Group pre-simulation balances by mint
  for (const [key, value] of preBalances.entries()) {
    if (key.startsWith('SOL:')) continue; // Skip SOL entries
    
    const { mint, amount } = value;
    const currentTotal = preMintTotals.get(mint) || 0;
    preMintTotals.set(mint, currentTotal + amount);
  }
  
  // Group post-simulation balances by mint
  for (const [key, value] of postBalances.entries()) {
    if (key.startsWith('SOL:')) continue; // Skip SOL entries
    
    const { mint, amount } = value;
    const currentTotal = postMintTotals.get(mint) || 0;
    postMintTotals.set(mint, currentTotal + amount);
  }
  
  // Calculate net changes for each token mint
  const allMints = new Set([...preMintTotals.keys(), ...postMintTotals.keys()]);
  
  for (const mint of allMints) {
    const preTotal = preMintTotals.get(mint) || 0;
    const postTotal = postMintTotals.get(mint) || 0;
    const difference = postTotal - preTotal;
    
    if (difference !== 0) {
      // Fetch token info
      const tokenInfo = await fetchTokenInfo(mint);
      
      if (difference > 0) {
        // Token amount increased (bought)
        tokensBought.push({
          mint,
          symbol: tokenInfo.symbol,
          amount: difference / Math.pow(10, tokenInfo.decimals),
          rawAmount: difference,
          decimals: tokenInfo.decimals,
          logouri: tokenInfo.logouri
        });
      } else {
        // Token amount decreased (sold)
        tokensSold.push({
          mint,
          symbol: tokenInfo.symbol,
          amount: Math.abs(difference) / Math.pow(10, tokenInfo.decimals),
          rawAmount: Math.abs(difference),
          decimals: tokenInfo.decimals,
          logouri: tokenInfo.logouri
        });
      }
    }
  }
  
  return {
    wallet: firstSignerWallet,
    tokensSold,
    tokensBought,
    success: simulationResult.value.err === null
  };
}

async function processTransaction(serializedTransaction: string, connection: Connection) {
  // Check first two characters to determine transaction type
  if (serializedTransaction.startsWith('AQ')) {
    console.log('Detected versioned transaction (AQ)');
    return await simulateVersionedTransactionWithBalanceChanges(serializedTransaction, connection);
  } else if (serializedTransaction.startsWith('Ag')) {
    console.log('Detected legacy transaction (Ag)');
    return await simulateTransactionWithBalanceChanges(serializedTransaction, connection);
  } else {
    console.log('Unknown transaction format');
    throw new Error('Unsupported transaction format');
  }
}

(async () => {
  
  const versionedTransaction = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAA8dKbWzyptKYH3aZwP4s5GTIwMXqW79T1Ym3E6QKfx8/HLdTUrAIRsOAZ19KeNOChmtaRMpwGssO2nDcwJAWOFbEQiv9uQQWSRmr5tIa+V2efL2i0HN3DHgIJJ3So9jYu0TBayoHTOdUqFQpTTmlcYCxzuubRIJvYlyvC9Es1X1Rof/Y345BvKghG0hRHuvetMklZxMuvzVWCfJy8IER162orZoeLVymYmX+CKgilcm6I6A8fWVNtHjncbvfyiklTfu9CfIDnyfkSytItj7Yt1pcCpMydfA0lqae4RgofpIE45VX2AfcyYCrkxkeEfI/LgrvIi8fKUJOn6EQc2In06sbQyeOuTgt5hK+hKdYAegnuCOli6hytpJ2uYSMpPCv8N9U4AicDRMXPriN7/tvNMFTXwZI2Wvwv71eVkqtlGUpVEqvWBoAb/1i0zKOnpRB8rwRnI0jTzvbiYQyeESBEkIIisH4oKmP6WPSIzYpURbqOnhEaQniavfFk5Q3y10NCfHhE7JNeR8NZ/jfoaUFSGG1zgNskQSrhCAfP38AVGOX2oXkbXcsTRnLUf+7HuTDSVxLUlrFeDnMta4y44wSA5TbQMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAABSGfiZqB1P+E+1k9Lt+KkKwbOrNCWPffIz6lAwKxvS4FfzZVmSjOG6uttluLXZ4xuif4U5vsYCzLGtwq+59GcMMbGMw+FIoKUpOBiSDt+u2rOR5JM2wLdNtmnRBHA0JLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqcnAQdYiz0VjUJzno4t9KCWVmIV1KcptX+F64GheRowbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpAAvj4euhekc/ibD36OJJQPIK6468pxqI/eldS4O3GgkLcGWx49F8RTidUn9rBMPNWLhscxqg/bVJttG8A/gpRkBovvq2RfyTWr622w1phgy/O/kgJqNXDd6fcsje4T3JCK/4lMP6Z8AWOjDyNKM9NGfwOqFkFzFetLgUJ72bpu0JhiKF43EKkNUdnkcC3pqd1en9yKyB0tKs0eHdyCT+xAan1RcYe9FmNdrUBFX9wsDBJMaPIVZ1pdu6y18IAAAAjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FkGp9UXGSxcUSGMyUw9SvF/WNruCJuh/UTj29mKAAAAAHRE+ndNzkJIFXZkxmR70yYU+i5A9NJ77Hon4tE7A7X6BQ4ACQOghgEAAAAAAA4ABQLAXBUADwYAEAECERIR8iPGiVLh8rb/YDBaCwAAAAAPCwAQEwMBAhEEAhQSJrgX7mFnxdM9gBCcCgAAAAABAAAAAAAAAAAAAAAAAAAAECcAAAAADx0AAAUQFQYHEwMRCAkEAQICFhcYGQoLGhsUEhwMDRTso8ytR5DrdoAQnAoAAAAAAADIAA==';
  
  const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
  
  try {
    const result = await processTransaction(versionedTransaction, connection);
    
    // Display a summary of the transaction results
    if (result) {    
      if (result) {
        console.log(JSON.stringify(result,null,2))
        console.log('Transaction simulation succeeded');
      } else {
        console.log('Transaction simulation failed');
      }
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
})();