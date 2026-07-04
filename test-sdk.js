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
      conditionId: '0xtest_market_brier_sdk_3',
      title: 'Will ADAN successfully migrate to Brier SDK?',
      yesPrice: 0.5,
      liquidity: 1000,
    },
    side: 'YES',
    probability: 0.95,
  });
  console.log('Done');
  process.exit(0);
}
run();
