/*
 * Pure indicator math functions. No I/O, no config dependency.
 * All operate on arrays of numbers and return the latest value (Number) or null.
 */

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i];
  }
  return sum / period;
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let emaVal = sma(values.slice(0, period), period);

  for (let i = period; i < values.length; i++) {
    emaVal = (values[i] - emaVal) * multiplier + emaVal;
  }

  return emaVal;
}

function rsi(values, period) {
  if (values.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < values.length; i++) {
    changes.push(values[i] - values[i - 1]);
  }

  const subChanges = changes.slice(changes.length - period);
  let avgGain = 0;
  let avgLoss = 0;

  for (const c of subChanges) {
    if (c > 0) avgGain += c;
    else avgLoss -= c;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(highs, lows, closes, period) {
  if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
    return null;
  }

  const tr = [];
  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  if (tr.length < period) return null;

  let atrVal = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    atrVal = (atrVal * (period - 1) + tr[i]) / period;
  }

  return atrVal;
}

// self-test
if (require.main === module && process.argv.includes("--test")) {
  let failures = 0;

  function assert(label, condition) {
    if (condition) {
      console.log(`PASS  ${label}`);
    } else {
      console.log(`FAIL  ${label}`);
      failures++;
    }
  }

  // ema constant series -> same constant
  const const5 = Array(20).fill(5);
  assert("ema([5...], 3) === 5", Math.abs(ema(const5, 3) - 5) < 0.0001);

  // sma simple
  assert("sma([2,4,6], 3) === 4", sma([2, 4, 6], 3) === 4);

  // rsi strictly increasing -> near 100
  const inc = [];
  for (let i = 0; i < 50; i++) inc.push(i);
  const rsiHigh = rsi(inc, 14);
  assert("rsi(strictly increasing, 14) > 99", rsiHigh > 99);

  // rsi strictly decreasing -> near 0
  const dec = [];
  for (let i = 50; i >= 0; i--) dec.push(i);
  const rsiLow = rsi(dec, 14);
  assert("rsi(strictly decreasing, 14) < 1", rsiLow < 1);

  // ema shorter than period -> null
  assert("ema(short series) === null", ema([1, 2, 3], 10) === null);

  // atr hand-checkable: 5 values, period 3
  // prices: h=[12,13,14,15,16], l=[10,11,11,12,13], c=[11,12,13,14,15]
  // TR[1]=max(13-11=2,|13-11|=2,|11-11|=0)=2
  // TR[2]=max(14-11=3,|14-12|=2,|11-12|=1)=3
  // TR[3]=max(15-12=3,|15-13|=2,|12-13|=1)=3
  // TR[4]=max(16-13=3,|16-14|=2,|13-14|=1)=3
  // First ATR (period 3) = (2+3+3)/3 = 2.666...
  // Next ATR = (2.666*2 + 3)/3 = 2.777...
  const highs = [12, 13, 14, 15, 16];
  const lows = [10, 11, 11, 12, 13];
  const closes = [11, 12, 13, 14, 15];
  const atrVal = atr(highs, lows, closes, 3);
  assert("atr hand-checkable ~ 2.777", Math.abs(atrVal - 2.777) < 0.01);

  // atr short series -> null
  assert("atr(short series) === null", atr([1], [1], [1], 5) === null);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures > 0 ? 1 : 0);
}

module.exports = { sma, ema, rsi, atr };
