import Papa from 'papaparse';

export const parseCSVFile = (file) => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        resolve(results.data);
      },
      error: (error) => {
        reject(error);
      }
    });
  });
};

export const processNinjaTraderData = async (files) => {
  let accountsData = [];
  let strategiesData = [];
  
  // Identify files by content or name
  for (const file of files) {
    const data = await parseCSVFile(file);
    if (data.length === 0) continue;
    
    // Check headers to identify type
    const headers = Object.keys(data[0]);
    if (headers.includes('Cash value') && headers.includes('Display name')) {
      accountsData = data;
    } else if (headers.includes('Strategy') && headers.includes('Account display name')) {
      strategiesData = data;
    }
  }

  // Process Accounts
  const accounts = accountsData.map(acc => ({
    connection: acc['Connection'],
    name: acc['Display name'],
    grossRealized: parseFloat(acc['Gross realized PnL'] || 0),
    cashValue: parseFloat(acc['Cash value'] || 0),
    unrealized: parseFloat(acc['Unrealized PnL'] || 0),
    weeklyPnL: parseFloat(acc['Weekly PnL'] || 0),
    drawdown: parseFloat(acc['Trailing max drawdown'] || 0)
  })).filter(acc => acc.name);

  // Process Strategies (Algorithms)
  const algorithms = strategiesData.map(str => {
    // Parse strings like "($1140.00)" to -1140 or "$307.50" to 307.5
    const parseCurrency = (val) => {
      if (!val) return 0;
      let clean = val.replace(/[\$,]/g, '');
      if (clean.startsWith('(') && clean.endsWith(')')) {
        clean = '-' + clean.substring(1, clean.length - 1);
      }
      return parseFloat(clean) || 0;
    };

    return {
      name: str['Strategy'],
      instrument: str['Instrument'],
      accountName: str['Account display name'],
      realized: parseCurrency(str['Realized']),
      unrealized: parseCurrency(str['Unrealized']),
      enabled: str['Enabled'] === 'True'
    };
  }).filter(str => str.accountName);

  return { accounts, algorithms };
};
