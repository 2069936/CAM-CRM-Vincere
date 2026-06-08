import { normalizeStrategyFamily, parseStrategyVersion } from './csvImport.js';

function titleDirection(value) {
  const text = String(value || '').trim();
  if (/^(long|short|both)$/i.test(text)) return text[0].toUpperCase() + text.slice(1).toLowerCase();
  return text;
}

function tagValue(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i'));
  return match ? match[1].trim() : '';
}

function numberValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberList(values) {
  return values.map(numberValue).filter((value) => value != null);
}

function normalizeArray(values) {
  return (values || []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

export function buildStrategySignature(settings = {}) {
  return {
    direction: titleDirection(settings.direction),
    posSizes: normalizeArray(settings.posSizes),
    profitTargets: normalizeArray(settings.profitTargets),
    stopLossTicks: numberValue(settings.stopLossTicks),
  };
}

function signatureKey(signature) {
  return [
    signature.direction || '',
    signature.posSizes.join(','),
    signature.profitTargets.join(','),
    signature.stopLossTicks ?? '',
  ].join('|');
}

function parseStrategySlot(strategyName) {
  const match = String(strategyName || '').match(/^(\d+)\s*-/);
  return match ? match[1] : '';
}

function parseNormalFileName(fileName) {
  const match = fileName.match(/^(\d+)\s*-\s*([A-Z0-9_]+)\s*\(([^)]+)\)\s*-\s*(.*?)\s*-\s*(Low|Medium|High)\s+Risk\s*-\s*(v\d+)\s*-\s*Period\s+(\d+)\.xml$/i);
  if (!match) return null;
  return {
    type: 'standard',
    riskTier: Number.parseInt(match[1], 10),
    family: normalizeStrategyFamily(match[2]),
    instrument: match[3].trim(),
    candle: match[4].replace(/\s+/g, ' ').trim(),
    risk: `${match[5][0].toUpperCase()}${match[5].slice(1).toLowerCase()} Risk`,
    setVersion: match[6],
    period: match[7],
  };
}

function parseBulletFileName(fileName) {
  const match = fileName.match(/^\d+-(L|S)\s*-\s*Bullet Bot\s*-\s*\(([^)]+)\)\s*(LONG|SHORT)\s*-\s*([^-]+?)\s*-\s*([^(]+?)\s*\(([^)]+)\)\s*-\s*Period\s+(\d+)\.xml$/i);
  if (!match) return null;
  return {
    type: 'bullet',
    family: 'Bullet Bot',
    passType: match[2].replace(/\s+/g, ' ').trim(),
    direction: titleDirection(match[3]),
    size: match[4].replace(/\s+/g, ' ').trim(),
    accountSize: match[5].replace(/\s+/g, ' ').trim(),
    target: match[6].replace(/\s+/g, ' ').trim(),
    period: match[7],
  };
}

export function parseSetFileName(fileName) {
  const baseName = String(fileName || '').split('/').pop();
  return parseBulletFileName(baseName) || parseNormalFileName(baseName) || {
    type: 'unknown',
    family: '',
    period: '',
  };
}

export function parseStrategySetXml(xml) {
  const strategyName = tagValue(xml, 'Name');
  const strategyFamily = normalizeStrategyFamily(strategyName);
  const candleValue = tagValue(tagValue(xml, 'BarsPeriodSerializable'), 'Value');
  const posSizes = numberList([
    tagValue(xml, 'PosSize1'),
    tagValue(xml, 'PosSize2'),
    tagValue(xml, 'PosSize3'),
    tagValue(xml, 'PositionSize'),
  ]);
  const profitTargets = numberList([
    tagValue(xml, 'ProfitTargetTicks1'),
    tagValue(xml, 'ProfitTargetTicks2'),
    tagValue(xml, 'ProfitTargetTicks3'),
    tagValue(xml, 'ProfitTargetTicks'),
  ]);
  const signature = buildStrategySignature({
    direction: tagValue(xml, 'MyTradeDirection'),
    posSizes,
    profitTargets,
    stopLossTicks: tagValue(xml, 'StopLossTicks'),
  });

  return {
    strategyName,
    strategyFamily,
    strategyVersion: parseStrategyVersion(strategyName),
    candleValue,
    signature,
  };
}

export function buildStrategySetRecord({ fileName, relativePath = '', xml }) {
  const label = parseSetFileName(fileName);
  const body = parseStrategySetXml(xml);
  return {
    fileName,
    relativePath,
    ...label,
    strategyName: body.strategyName,
    strategyFamily: body.strategyFamily,
    strategyVersion: body.strategyVersion,
    candleValue: body.candleValue,
    labelFamily: label.family || '',
    family: body.strategyFamily || label.family,
    signature: body.signature,
  };
}

export function matchStrategySet(strategy, setRecords = []) {
  if (!strategy?.params?.parsed) {
    return { matched: false, reason: 'Strategy parameters not parsed' };
  }

  const family = normalizeStrategyFamily(strategy.strategyFamily || strategy.strategyName);
  const runningKey = signatureKey(buildStrategySignature(strategy.params));
  const signatureMatches = setRecords.filter((record) => {
    if (normalizeStrategyFamily(record.family || record.strategyFamily) !== family) return false;
    return signatureKey(record.signature) === runningKey;
  });
  const strategySlot = parseStrategySlot(strategy.strategyName);
  const matches = strategySlot
    ? signatureMatches.filter((record) => String(record.period || '') === strategySlot)
    : signatureMatches;

  if (matches.length === 1) {
    const [match] = matches;
    return {
      matched: true,
      fileName: match.fileName,
      relativePath: match.relativePath,
      risk: match.risk || '',
      riskTier: match.riskTier || null,
      setVersion: match.setVersion || '',
      period: match.period || '',
      passType: match.passType || '',
      direction: match.direction || match.signature?.direction || '',
      size: match.size || '',
      target: match.target || '',
      accountSize: match.accountSize || '',
      candle: match.candle || '',
    };
  }

  if (matches.length > 1) return { matched: false, reason: 'Ambiguous XML strategy match' };
  return { matched: false, reason: 'No XML strategy match' };
}

export function enrichStrategyWithSetMatch(strategy, setRecords = []) {
  return {
    ...strategy,
    configMatch: matchStrategySet(strategy, setRecords),
  };
}
