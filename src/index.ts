import {
    Connection,
    Transaction,
    PublicKey,
  } from '@solana/web3.js';
  import {
    AccountLayout,
    ACCOUNT_SIZE,
    TOKEN_PROGRAM_ID,
  } from '@solana/spl-token';
  
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
    console.log(`Transaction involves ${uniqueAccounts.length} unique accounts`);
    
    // Get pre-simulation token balances 
    const preBalances = new Map();
    for (const accountAddress of uniqueAccounts) {
      const pubkey = new PublicKey(accountAddress);
      try {
        const accountInfo = await connection.getAccountInfo(pubkey);
        
        // Check if this is a token account
        if (accountInfo && accountInfo.owner.equals(TOKEN_PROGRAM_ID) && accountInfo.data.length === ACCOUNT_SIZE) {
          const decoded = AccountLayout.decode(accountInfo.data);
          const mint = decoded.mint.toString();
          const amount = Number(decoded.amount);
          
          preBalances.set(accountAddress, { mint, amount });
          console.log(`Pre-simulation: Account ${accountAddress.substring(0, 6)}... holds ${amount} of token ${mint.substring(0, 6)}...`);
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
      return;
    }
    
    // Map accounts returned from simulation back to the transaction accounts
    // The accounts are returned in the same order they appear in the transaction
    const postBalances = new Map();
    
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
            
            postBalances.set(accountPubkey, { mint, amount });
            console.log(`Post-simulation: Account ${accountPubkey.substring(0, 6)}... holds ${amount} of token ${mint.substring(0, 6)}...`);
          }
        } catch (error : any) {
          console.log(`Error decoding account data: ${error.message}`);
        }
      }
    }
    
    // Calculate and display changes
    console.log('\n--- Token Balance Changes ---');
    for (const [account, postData] of postBalances.entries()) {
      const preData = preBalances.get(account);
      
      if (preData) {
        const change = postData.amount - preData.amount;
        if (change !== 0) {
          const sign = change > 0 ? '+' : '';
          console.log(`Account ${account.substring(0, 8)}... : ${sign}${change} of token ${postData.mint.substring(0, 8)}...`);
        }
      } else {
        // New token account
        console.log(`New token account ${account.substring(0, 8)}... : ${postData.amount} of token ${postData.mint.substring(0, 8)}...`);
      }
    }
    
    // Check for closed accounts
    for (const [account, preData] of preBalances.entries()) {
      if (!postBalances.has(account)) {
        console.log(`Account ${account.substring(0, 8)}... closed (previously had ${preData.amount} of token ${preData.mint.substring(0, 8)}...)`);
      }
    }
    
    return {
      preBalances: Object.fromEntries(preBalances),
      postBalances: Object.fromEntries(postBalances),
      success: simulationResult.value.err === null
    };
  }

(async () => {
    const serializedTransaction = 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AN+I4pFaQHDDGbTZeZe9ZuItKn2FHICkIUUmFHLUvuoPMwr8dVX1TIPBqqtBKovELfs0FnUvzRxoVoYzJOUHAgAIDim1s8qbSmB92mcD+LORkyMDF6lu/U9WJtxOkCn8fPxyqSfS21hJ+oTOehEXEYBeaNqsydDYjZqf1L/AldJw2uQxZyp5L3sCX7zdsAW9rnpRyBCLHI0vXFrgSBwRZLSrwm0cZ5LhNGqUuyoosHzgX4qKklM/mXZfbY5P3YFhXjGWft+3fJSORlmRgYAXTiZcs1qBcx55aF4mZdpJIjXCgz3KsxPL0i0kx3BFeEWSduJHsmNSBIqhASLhf5UVNsz7WAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwZGb+UhFzL/7K26csOb57yM5bvF9xJrLEObOkAAAAAFSlNamSkhBk0k6HFg2jh8fDW13bySu4HkH6hAQQVEjQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpM4q6xj0HkaERh2Zuqn+xa51t3JEl5PL8COT42q2vaDeMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WbwHxW5grT0/F3OC6sZUj7of0yz9kMoCs+fPoYX9znOY870t5h5iwpEaFSbn0ADhmHWooZImTFM6LC9B7H84XZglHPT6+uWMkrGDwq48j8Yk6fO7qdoAEHfe2IvUK43xzQUHAAUCQA0DAAcACQNAQg8AAAAAAAoKAQAFDA0CBAkLBhiK4+hN36Zgxa+ebN7S/RUDAJ7rERQAAAAIAQEsRGVwb3NpdCA2MWY3NzBjMC1kOWMwLTQwMDktYTA1My1mZmE4MGVhNzM3YmEGAgADDAIAAADIDD4AAAAAAA==';
    const connection = new Connection('https://greatest-polished-owl.solana-mainnet.quiknode.pro/f70604dd15c9c73615a9bd54d36060d0696935f3');
    
    await simulateTransactionWithBalanceChanges(serializedTransaction, connection);
})();