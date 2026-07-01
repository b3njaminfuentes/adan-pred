import { reportPaperBet, reportTelemetry } from './src/api/brier-reporter.js';

async function run() {
  console.log('Sending telemetry...');
  reportTelemetry('Scanning Polymarket & Binance...', 'Positions: 0/3 Open');
  // Wait 5 seconds to let the interval loop send the heartbeat
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log('Sending bet...');
  await reportPaperBet({
    market: {
      id: '0xtest_market_brier_sdk_3',
      condition_id: '0xtest_market_brier_sdk_3',
      question: 'Will ADAN successfully migrate to Brier SDK?',
      slug: 'adan-brier-sdk-migration',
      category: 'Crypto',
      liquidity: 1000
    },
    side: 'YES',
    confidence: 0.95,
  });
  console.log('Done');
  process.exit(0);
}
run();
