var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region src/domain/pnlSourceSummary.js
var PNL_SOURCES = [
	"realized",
	"gross_fallback",
	"gross_missing_realized",
	"unavailable"
];
function summarizePnlSources(rows = []) {
	const summary = {
		realized: 0,
		gross_fallback: 0,
		gross_missing_realized: 0,
		unavailable: 0,
		unknown: 0
	};
	for (const row of rows || []) {
		const source = PNL_SOURCES.includes(row?.pnlSource) ? row.pnlSource : "unknown";
		summary[source] += 1;
	}
	return summary;
}
//#endregion
//#region src/domain/tradingDayScope.js
/** Live states. An order in one of these is working now, whenever it was placed. */
var LIVE_ORDER_STATES = /* @__PURE__ */ new Set([
	"initialized",
	"submitted",
	"accepted",
	"working",
	"pending submit",
	"pending change",
	"pending cancel",
	"cancel pending",
	"partially filled",
	"change pending",
	"triggered"
]);
/**
* NinjaTrader writes `7/13/2026 12:15:35 PM`; the CRM stores ISO. Both appear
* depending on whether a row came from a grid export or the AddOn.
*/
function tradingDateOf(value) {
	const text = String(value || "").trim();
	if (!text) return null;
	const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
	const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
	return iso ? iso[1] : null;
}
function isLiveOrderState(state) {
	const text = String(state || "").trim().toLowerCase();
	if (!text) return false;
	if (text.startsWith("rejected")) return false;
	return LIVE_ORDER_STATES.has(text);
}
/**
* Orders belonging to a trading day.
*
* A working order placed last Friday is still live on Monday and still that
* client's exposure, so state outranks date. Anything filled, cancelled or
* rejected on an earlier day is finished business and belongs to the day it
* happened on, not to this one.
*
* An order with no readable timestamp is kept. Dropping rows because a format
* was not recognised would quietly delete real trading, which is a worse
* failure than carrying a few extra.
*/
function scopeOrdersToDay(orders = [], date) {
	const day = tradingDateOf(date) || String(date || "").slice(0, 10);
	if (!day) return orders;
	return orders.filter((order) => {
		const when = tradingDateOf(order?.time);
		if (!when) return true;
		if (when === day) return true;
		return isLiveOrderState(order?.state);
	});
}
/**
* Executions belonging to a trading day.
*
* No state exception here: a fill is an event with a time. One from last week
* happened last week, and counting it today would double it — it was already
* counted on the day it occurred.
*/
function scopeExecutionsToDay(executions = [], date) {
	const day = tradingDateOf(date) || String(date || "").slice(0, 10);
	if (!day) return executions;
	return executions.filter((execution) => {
		const when = tradingDateOf(execution?.time);
		return when === null || when === day;
	});
}
//#endregion
//#region src/domain/derivedAccountMetrics.js
var MS_PER_DAY = 864e5;
function toDate(value) {
	const text = String(value || "").slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}
/** Monday of the week containing the date. Closes are Mon-Fri, so a
*  Sunday-start futures week would sum identically. */
function weekStart(date) {
	const day = toDate(date);
	if (!day) return "";
	const parsed = /* @__PURE__ */ new Date(`${day}T12:00:00Z`);
	const weekday = parsed.getUTCDay();
	const backToMonday = weekday === 0 ? 6 : weekday - 1;
	return (/* @__PURE__ */ new Date(parsed.getTime() - backToMonday * MS_PER_DAY)).toISOString().slice(0, 10);
}
function numeric$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function snapshotFor(dailyImport, accountName) {
	const wanted = String(accountName || "").toLowerCase();
	return (dailyImport?.snapshots || []).find((snapshot) => String(snapshot.accountName || "").toLowerCase() === wanted) || null;
}
/**
* Realized PnL for the account across the trading week ending on the given date.
* Exact — every day of the week is one of our own closes.
*/
function deriveWeeklyPnl(dailyImports = [], accountName, asOfDate) {
	const day = toDate(asOfDate);
	const start = weekStart(day);
	if (!day || !start) return null;
	let total = 0;
	let days = 0;
	for (const dailyImport of dailyImports) {
		const date = toDate(dailyImport?.date);
		if (!date || date < start || date > day) continue;
		const snapshot = snapshotFor(dailyImport, accountName);
		if (!snapshot) continue;
		const pnl = numeric$1(snapshot.grossRealizedPnl);
		if (pnl === null) continue;
		total += pnl;
		days += 1;
	}
	if (!days) return null;
	return {
		value: total,
		source: "derived",
		daysCounted: days,
		weekStart: start
	};
}
/**
* How far the account has fallen from its highest recorded balance.
*
* Returns the same shape the Accounts grid reports (drawdown from peak, as a
* positive number), plus the evidence behind it so a caller can judge how much
* to trust it: the peak used, when it happened, how many closes it is based on,
* and whether the history has holes.
*
* `startBalance` seeds the peak, so an account that only ever lost money still
* measures from where it began rather than from its best bad day.
*/
function deriveTrailingDrawdown(dailyImports = [], accountName, asOfDate, { startBalance = null } = {}) {
	const day = toDate(asOfDate);
	if (!day) return null;
	const balances = [];
	for (const dailyImport of dailyImports) {
		const date = toDate(dailyImport?.date);
		if (!date || date > day) continue;
		const snapshot = snapshotFor(dailyImport, accountName);
		if (!snapshot) continue;
		const balance = numeric$1(snapshot.accountBalance);
		if (balance === null) continue;
		balances.push({
			date,
			balance
		});
	}
	if (!balances.length) return null;
	balances.sort((a, b) => a.date.localeCompare(b.date));
	const current = balances[balances.length - 1];
	if (current.date !== day) return null;
	let peak = Number(startBalance) > 0 ? Number(startBalance) : balances[0].balance;
	let peakDate = balances[0].date;
	for (const point of balances) if (point.balance > peak) {
		peak = point.balance;
		peakDate = point.date;
	}
	const firstDate = balances[0].date;
	const spanDays = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${firstDate}T12:00:00Z`)) / MS_PER_DAY);
	const weekdaysInSpan = countWeekdays(firstDate, day);
	const hasGaps = balances.length < weekdaysInSpan;
	return {
		value: Math.max(0, peak - current.balance),
		source: "derived",
		peak,
		peakDate,
		closesUsed: balances.length,
		spanDays,
		hasGaps,
		isLowerBound: true
	};
}
function countWeekdays(fromDate, toDateValue) {
	const start = Date.parse(`${fromDate}T12:00:00Z`);
	const end = Date.parse(`${toDateValue}T12:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
	let count = 0;
	for (let time = start; time <= end; time += MS_PER_DAY) {
		const weekday = new Date(time).getUTCDay();
		if (weekday !== 0 && weekday !== 6) count += 1;
	}
	return count;
}
/**
* Thresholds for acting on a drawdown number, widened when it is derived.
*
* A derived drawdown is a lower bound, so warning at the same level as a
* reported one would warn too late on an account that is actually closer to its
* limit than we can see. Doubling the margins costs a few early warnings and
* buys not missing a real one.
*
* The widening exists because we do not know whether a firm trails from the
* intraday high or from the daily close. Recording that per firm would make the
* derivation exact where the basis is end-of-day, and honest about being
* impossible where it is not — see docs/prop-firm-rules-catalog.md.
*/
function drawdownThresholds(source) {
	return source === "derived" ? {
		critical: 1e3,
		warning: 2400
	} : {
		critical: 500,
		warning: 1200
	};
}
//#endregion
//#region src/domain/instrumentSpecs.js
var SPECS = {
	NQ: {
		pointValue: 20,
		tickSize: .25
	},
	MNQ: {
		pointValue: 2,
		tickSize: .25
	},
	ES: {
		pointValue: 50,
		tickSize: .25
	},
	MES: {
		pointValue: 5,
		tickSize: .25
	},
	RTY: {
		pointValue: 50,
		tickSize: .1
	},
	M2K: {
		pointValue: 5,
		tickSize: .1
	},
	YM: {
		pointValue: 5,
		tickSize: 1
	},
	MYM: {
		pointValue: .5,
		tickSize: 1
	},
	GC: {
		pointValue: 100,
		tickSize: .1
	},
	MGC: {
		pointValue: 10,
		tickSize: .1
	},
	SI: {
		pointValue: 5e3,
		tickSize: .005
	},
	PL: {
		pointValue: 50,
		tickSize: .1
	},
	CL: {
		pointValue: 1e3,
		tickSize: .01
	},
	MCL: {
		pointValue: 100,
		tickSize: .01
	},
	NG: {
		pointValue: 1e4,
		tickSize: .001
	},
	QG: {
		pointValue: 2500,
		tickSize: .005
	},
	ZB: {
		pointValue: 1e3,
		tickSize: 1 / 32
	}
};
function instrumentRoot(instrument) {
	const m = String(instrument || "").trim().match(/^([A-Za-z0-9]+?)(?:\s|[FGHJKMNQUVXZ]\d{1,2}$)/);
	return ((m ? m[1] : String(instrument || "").trim().split(/\s+/)[0]) || "").toUpperCase();
}
//#endregion
//#region src/domain/deriveStrategyPnl.js
var RESIDUAL_REASONS = {
	CROSS_STRATEGY: "cross-strategy",
	DETACHED_EXIT: "detached-exit",
	MANUAL_LEG: "manual-leg",
	NO_STRATEGY: "no-strategy",
	CARRY_IN: "carry-in-refused",
	UNKNOWN_INSTRUMENT: "unknown-instrument",
	POSITION_UNREPRODUCIBLE: "position-unreproducible"
};
var BOOK_REFUSALS = {
	CARRY_IN: RESIDUAL_REASONS.CARRY_IN,
	UNKNOWN_INSTRUMENT: RESIDUAL_REASONS.UNKNOWN_INSTRUMENT,
	POSITION_UNREPRODUCIBLE: RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE
};
var DEFAULT_TOLERANCE = .005;
var ROOTS_BY_LENGTH = Object.keys(SPECS).sort((a, b) => b.length - a.length);
var num$1 = (value) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};
/**
* Point multiplier for an instrument string.
*
* The grid writes the same contract three ways — 'MNQ SEP26', 'MNQ 09-26',
* 'MNQU6' — so the month-code-aware root is tried first and a longest-known-root
* prefix match on the alphanumeric-stripped string is the fallback. Returns null
* for an instrument with no spec; its book is refused, not valued at zero.
*/
function multiplierFor(instrument) {
	const direct = SPECS[instrumentRoot(instrument)];
	if (direct) return direct.pointValue;
	const cleaned = String(instrument || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
	for (const root of ROOTS_BY_LENGTH) if (cleaned.startsWith(root)) return SPECS[root].pointValue;
	return null;
}
/** '2 S' -> -2, '4 L' -> 4, '-' / '' -> 0. The position AFTER the fill. */
function parsePosition(value) {
	const text = String(value ?? "").trim();
	if (!text || text === "-") return 0;
	const match = text.match(/^(-?[\d.]+)\s*([LS])?/i);
	if (!match) return null;
	const size = Number.parseFloat(match[1]);
	if (!Number.isFinite(size)) return null;
	if (/^s$/i.test(match[2] || "")) return -Math.abs(size);
	if (/^l$/i.test(match[2] || "")) return Math.abs(size);
	return size;
}
/** NinjaTrader writes '8/18/2026 9:30:01 AM'; the AddOn writes ISO. */
function parseExecutionTime(value) {
	const text = String(value || "").trim();
	if (!text) return null;
	const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([AP]M)?/i);
	if (us) {
		let hour = Number(us[4]);
		if (us[8]) {
			const pm = /^pm$/i.test(us[8]);
			hour = hour % 12 + (pm ? 12 : 0);
		}
		return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), hour, Number(us[5]), Number(us[6]), Number(us[7] || 0));
	}
	const parsed = Date.parse(text);
	return Number.isFinite(parsed) ? parsed : null;
}
function execSequence(execution) {
	const id = String(execution?.id || "").trim();
	const pair = id.match(/^(\d+)_(\d+)$/);
	if (pair) return {
		form: "pair",
		major: Number(pair[1]),
		minor: Number(pair[2])
	};
	if (/^\d+$/.test(id)) return {
		form: "int",
		major: Number(id),
		minor: 0
	};
	return null;
}
var signedQty$1 = (execution) => (/^buy/i.test(String(execution?.action || "")) ? 1 : -1) * Math.abs(num$1(execution?.quantity));
/** True when this fill's E/X column says it closed a position. */
function isExitFill(execution) {
	return /^exit$/i.test(String(execution?.entryExit || "").trim());
}
/**
* How many fills in this ordering contradict the Position column.
*
* Position is the account's position in that instrument AFTER the fill, so a
* correct ordering reproduces it exactly from Action + Quantity. Zero mismatches
* is the signal that the fills are in the order they actually happened.
*/
function positionMismatches(executions) {
	if (!executions.length) return 0;
	const firstStated = parsePosition(executions[0]?.position);
	let running = firstStated == null ? 0 : firstStated - signedQty$1(executions[0]);
	let mismatches = 0;
	for (const execution of executions) {
		running += signedQty$1(execution);
		const stated = parsePosition(execution?.position);
		if (stated != null && Math.abs(running - stated) > 1e-9) mismatches += 1;
	}
	return mismatches;
}
function permutations(items) {
	if (items.length <= 1) return [items];
	const out = [];
	for (let i = 0; i < items.length; i += 1) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([items[i], ...rest]);
	return out;
}
/**
* Reorder fills that share a sort key so the Position column comes out right.
*
* Timestamps tie: a real export had two fills on one instrument stamped the same
* second, and the wrong one first made the leg look as though it had carried a
* contract in overnight. That invented an unpriced lot, dropped a real pair, and
* left the account $13.75 short of its own gross — a plausible-looking wrong
* number, which is the exact failure this module exists to prevent.
*
* HOW MUCH WORK THIS ACTUALLY DOES, MEASURED. On the 2026-08-20 book 743 of
* 3,805 timestamp-ordered books contain a same-second tie (1,014 runs, 2,128
* fills; runs of 2 x 935, 3 x 63, 4 x 11, 5 x 5), and the column pins 727 to
* exactly ONE admissible ordering. Eight admit several, and on all eight the
* per-strategy split is identical — so where this function has a choice, the
* choice is worth $0. Ties are two rows long in practice; the search is capped
* so a pathological grid degrades to "leave it alone" rather than hanging (one
* book on that export exceeds the cap).
*
* IT RETURNS ITS BEST CANDIDATE, WHICH IS NOT ALWAYS A GOOD ONE, AND THAT IS
* DELIBERATE. When no permutation inside the tie runs reproduces the column, the
* fills are out of sequence across DISTINCT timestamps and no tie-break can
* repair them. This function does not decide what to do about that; it hands
* back the least-bad ordering and rule 6 in planBooks REFUSES the book by name.
* Silently keeping the least-bad ordering and pairing on it is what happened
* before, and it left the money unnamed and unpriceable-but-priced.
*/
function resolveTiesByPosition(executions, keys) {
	if (executions.length < 2 || positionMismatches(executions) === 0) return executions;
	const runs = [];
	for (let i = 0; i < executions.length;) {
		let j = i + 1;
		while (j < executions.length && keys[j] === keys[i]) j += 1;
		if (j - i > 1) runs.push([i, j]);
		i = j;
	}
	if (!runs.length) return executions;
	const perRun = runs.map(([from, to]) => permutations(executions.slice(from, to)));
	const combinations = perRun.reduce((n, list) => n * list.length, 1);
	if (combinations > 5040) return executions;
	let best = executions;
	let bestScore = positionMismatches(executions);
	for (let n = 0; n < combinations; n += 1) {
		const candidate = [...executions];
		let cursor = n;
		for (let r = 0; r < runs.length; r += 1) {
			const list = perRun[r];
			const choice = list[cursor % list.length];
			cursor = Math.floor(cursor / list.length);
			for (let k = 0; k < choice.length; k += 1) candidate[runs[r][0] + k] = choice[k];
		}
		const score = positionMismatches(candidate);
		if (score < bestScore) {
			best = candidate;
			bestScore = score;
			if (!score) break;
		}
	}
	return best;
}
/**
* Chronological order for one account's fills.
*
* Execution id first, timestamp second, and file order only when neither is
* readable. `basis` says which was used so a caller can see how the grid was
* ordered — falling back to row order silently is how a reversed export produces
* a plausible wrong number. Measured across ten client folders: six executions
* grids were time-DESCENDING, three were grouped by the E/X column, none was
* ascending. There is no fixed direction that works.
*
* Ties are then broken per instrument against the Position column, which is the
* only witness in the file to what order the fills really happened in.
*
* NOTHING may read a book's "first" fill without coming through here. Reading
* row 1 of a time-descending grid as the day's opening fill is what produced the
* 2026-08-19 misdiagnosis recorded in the header: 25 of 31 books "started" with
* an exit in file order, 0 of 31 did once ordered.
*/
function orderExecutions(executions = []) {
	const rows = executions.map((execution, index) => ({
		execution,
		index,
		seq: execSequence(execution),
		time: parseExecutionTime(execution?.time)
	}));
	const forms = new Set(rows.map((row) => row.seq?.form));
	const basis = rows.every((row) => row.seq) && forms.size === 1 ? "executionId" : rows.every((row) => row.time != null) ? "time" : "fileOrder";
	const sorted = [...rows].sort((a, b) => {
		if (basis === "executionId") return a.seq.major - b.seq.major || a.seq.minor - b.seq.minor || a.index - b.index;
		if (basis === "time") return a.time - b.time || a.index - b.index;
		return a.index - b.index;
	});
	const keyOf = (row) => basis === "executionId" ? `${row.seq.major}_${row.seq.minor}` : basis === "time" ? String(row.time) : `i${row.index}`;
	const byInstrument = /* @__PURE__ */ new Map();
	for (const row of sorted) {
		const instrument = String(row.execution?.instrument || "").trim();
		if (!byInstrument.has(instrument)) byInstrument.set(instrument, []);
		byInstrument.get(instrument).push(row);
	}
	const resolved = /* @__PURE__ */ new Map();
	for (const [instrument, group] of byInstrument) resolved.set(instrument, resolveTiesByPosition(group.map((row) => row.execution), group.map(keyOf)));
	const cursors = /* @__PURE__ */ new Map();
	return {
		ordered: sorted.map((row) => {
			const instrument = String(row.execution?.instrument || "").trim();
			const index = cursors.get(instrument) || 0;
			cursors.set(instrument, index + 1);
			return resolved.get(instrument)[index];
		}),
		basis
	};
}
function emptyResidual() {
	return {
		realized: 0,
		pairs: 0,
		reasons: {}
	};
}
function addResidual(residual, reason, pnl) {
	residual.pairs += 1;
	residual.reasons[reason] = (residual.reasons[reason] || 0) + 1;
	if (pnl != null) residual.realized += pnl;
	return residual;
}
/**
* Normalise whatever the caller knows about the previous close.
*
* `null` / omitted is the honest answer for a caller with no history at all, and
* it is NOT the same as "there was nothing open": it means nobody looked. Both
* end in the same refusal, but only one of them is a bug if it ever shows up on
* a caller that does hold the history.
*/
function normalizeCarryIn(carryIn) {
	if (!carryIn) return {
		available: false,
		reason: "no-history",
		priorDate: null,
		lotsByInstrument: /* @__PURE__ */ new Map()
	};
	const lotsByInstrument = /* @__PURE__ */ new Map();
	for (const lot of carryIn.lots || []) {
		const key = String(lot?.instrument || "").trim();
		if (!lotsByInstrument.has(key)) lotsByInstrument.set(key, []);
		lotsByInstrument.get(key).push(lot);
	}
	return {
		available: Boolean(carryIn.available),
		reason: String(carryIn.reason || ""),
		priorDate: carryIn.priorDate ?? null,
		lotsByInstrument
	};
}
/**
* Decide, before any pricing, whether each book can be priced at all.
*
* Returns instrument -> { multiplier, refusal, seedLots, impliedStart,
* namedStrategies }. Every decision here is made from the ORDERED fills; see the
* warning on orderExecutions about reading row 1 of a descending grid.
*/
function planBooks(orderedByInstrument, { strategyOf, carryIn }) {
	const plans = /* @__PURE__ */ new Map();
	for (const [instrument, fills] of orderedByInstrument) {
		const multiplier = multiplierFor(instrument);
		const first = fills[0];
		const statedFirst = parsePosition(first?.position);
		const startKnown = statedFirst != null;
		const impliedStart = startKnown ? statedFirst - signedQty$1(first) : null;
		const carriesIn = isExitFill(first) || startKnown && impliedStart !== 0;
		const namedStrategies = /* @__PURE__ */ new Set();
		for (const fill of fills) {
			const strategyName = strategyOf(fill?.orderId);
			if (strategyName) namedStrategies.add(strategyName);
		}
		const phantom = () => startKnown && impliedStart !== 0 ? [{
			side: impliedStart > 0 ? 1 : -1,
			qty: Math.abs(impliedStart),
			price: null,
			orderId: "",
			strategyName: ""
		}] : [];
		let refusal = null;
		let seedLots = [];
		if (multiplier == null) {
			refusal = BOOK_REFUSALS.UNKNOWN_INSTRUMENT;
			seedLots = phantom();
		} else if (positionMismatches(fills) > 0) {
			refusal = BOOK_REFUSALS.POSITION_UNREPRODUCIBLE;
			seedLots = phantom();
		} else if (carriesIn) {
			const lots = carryIn.available ? carryIn.lotsByInstrument.get(instrument) || [] : [];
			const net = lots.reduce((total, lot) => total + lot.side * Math.abs(num$1(lot.qty)), 0);
			const priced = lots.length > 0 && lots.every((lot) => Number.isFinite(Number(lot.price)));
			if (startKnown && priced && Math.abs(net - impliedStart) < 1e-9) seedLots = lots.map((lot) => ({
				side: lot.side,
				qty: Math.abs(num$1(lot.qty)),
				price: Number(lot.price),
				orderId: "",
				strategyName: String(lot.strategyName || "")
			}));
			else {
				refusal = BOOK_REFUSALS.CARRY_IN;
				seedLots = phantom();
			}
		}
		plans.set(instrument, {
			multiplier,
			refusal,
			seedLots,
			carriesIn,
			carriedInContracts: carriesIn && startKnown ? Math.abs(impliedStart) : 0,
			impliedStart: startKnown ? impliedStart : 0,
			namedStrategies
		});
	}
	return plans;
}
/**
* Per-strategy realized P&L for ONE account's trading day.
*
* @param {object[]} executions fills for a single account, as mapExecution shapes them
* @param {object[]} orders     that account's orders (or the whole day's — joined by id)
* @param {number|null} reportedGross the Accounts grid's 'Gross realized PnL' for this
*        account, used only to gate the result. Pass null when the grid did not
*        carry the column; the account is then REFUSED ('no-reported-gross')
*        rather than compared against undefined or against the net column.
* @param {object|null} carryIn what the caller knows about the previous close —
*        `{ available, reason, priorDate, lots: [{ instrument, side, qty, price,
*        strategyName }] }`, as carryForwardLots.js builds it. Omit it (or pass
*        null) when the caller has no history; every carried-in book is then
*        refused. Omitting it is a refusal, never a claim that nothing was open.
*
* Returns per-strategy rows plus everything a caller needs to decide whether it
* may show them. `status` is the short answer:
*   'no-trades'         the account did not trade
*   'refused'           a book could not be priced at all — carry-in with no
*                       basis, an instrument with no multiplier, or an ordering
*                       the Position column contradicts. Nothing about this
*                       account may be published.
*   'no-reported-gross' the Accounts grid carried no 'Gross realized PnL', so
*                       nothing could check the total. Also unpublishable.
*   'exact'             every closed pair is attributed AND the total matches gross
*   'partial'           the total matches gross but some pairs could not be attributed
*   'unreconciled'      the derived total does not match gross — show nothing per-algo
*/
function deriveStrategyPnl({ executions = [], orders = [], reportedGross = null, carryIn = null, tolerance = DEFAULT_TOLERANCE } = {}) {
	const orderById = /* @__PURE__ */ new Map();
	for (const order of orders || []) {
		const id = String(order?.id || "").trim();
		if (id) orderById.set(id, order);
	}
	const strategyOf = (orderId) => String(orderById.get(String(orderId || "").trim())?.strategyName || "").trim();
	const nameOf = (orderId) => String(orderById.get(String(orderId || "").trim())?.name || "").trim();
	const { ordered, basis } = orderExecutions(executions);
	if (!ordered.length) return {
		byStrategy: [],
		residual: emptyResidual(),
		attributedTotal: 0,
		derivedTotal: 0,
		reportedGross,
		difference: reportedGross == null ? null : -num$1(reportedGross),
		pairs: 0,
		unpricedPairs: 0,
		detachedPairs: 0,
		openContracts: 0,
		carriedInContracts: 0,
		refusedBooks: [],
		unknownInstruments: [],
		carryInBasis: carryIn?.available ? "prior-close" : carryIn?.reason || "no-history",
		orderingBasis: basis,
		positionAgrees: true,
		reconciles: reportedGross == null ? false : Math.abs(num$1(reportedGross)) <= tolerance,
		status: "no-trades"
	};
	const normalizedCarryIn = normalizeCarryIn(carryIn);
	const orderedByInstrument = /* @__PURE__ */ new Map();
	for (const execution of ordered) {
		const instrument = String(execution?.instrument || "").trim();
		if (!orderedByInstrument.has(instrument)) orderedByInstrument.set(instrument, []);
		orderedByInstrument.get(instrument).push(execution);
	}
	const plans = planBooks(orderedByInstrument, {
		strategyOf,
		carryIn: normalizedCarryIn
	});
	const books = /* @__PURE__ */ new Map();
	const runningPosition = /* @__PURE__ */ new Map();
	const attributed = /* @__PURE__ */ new Map();
	const residual = emptyResidual();
	const unknownInstruments = /* @__PURE__ */ new Set();
	const refusedBooks = [];
	let pairs = 0;
	let unpricedPairs = 0;
	let detachedPairs = 0;
	let carriedInContracts = 0;
	let attributedTotal = 0;
	let derivedTotal = 0;
	let positionAgrees = true;
	for (const [instrument, plan] of plans) {
		if (plan.multiplier == null) unknownInstruments.add(instrumentRoot(instrument) || instrument);
		carriedInContracts += plan.carriedInContracts;
		if (plan.refusal) refusedBooks.push({
			instrument,
			reason: plan.refusal,
			carriedInContracts: plan.carriedInContracts,
			carryInReason: plan.refusal === BOOK_REFUSALS.CARRY_IN ? normalizedCarryIn.available ? "no-matching-lots" : normalizedCarryIn.reason : ""
		});
		books.set(instrument, plan.seedLots.map((lot) => ({ ...lot })));
		runningPosition.set(instrument, plan.seedLots.length ? plan.seedLots.reduce((total, lot) => total + lot.side * lot.qty, 0) : plan.impliedStart);
	}
	for (const execution of ordered) {
		const instrument = String(execution?.instrument || "").trim();
		const plan = plans.get(instrument);
		const multiplier = plan.multiplier;
		const side = /^buy/i.test(String(execution?.action || "")) ? 1 : -1;
		const filled = Math.abs(num$1(execution?.quantity));
		const price = num$1(execution?.price);
		const stated = parsePosition(execution?.position);
		const book = books.get(instrument);
		let remaining = filled;
		while (remaining > 0 && book.length && book[0].side !== side) {
			const lot = book[0];
			const take = Math.min(remaining, lot.qty);
			pairs += 1;
			if (plan.refusal) {
				unpricedPairs += 1;
				addResidual(residual, plan.refusal, null);
			} else {
				const openStrategy = lot.strategyName != null && lot.strategyName !== "" ? lot.strategyName : lot.orderId ? strategyOf(lot.orderId) : "";
				const closeStrategy = strategyOf(execution?.orderId);
				const pnl = (price - lot.price) * take * multiplier * (lot.side === 1 ? 1 : -1);
				derivedTotal += pnl;
				const credit = (strategyName) => {
					const row = attributed.get(strategyName) || {
						realized: 0,
						pairs: 0
					};
					row.realized += pnl;
					row.pairs += 1;
					attributed.set(strategyName, row);
					attributedTotal += pnl;
				};
				if (openStrategy && closeStrategy && openStrategy === closeStrategy) credit(openStrategy);
				else if (openStrategy && closeStrategy) addResidual(residual, RESIDUAL_REASONS.CROSS_STRATEGY, pnl);
				else if (openStrategy || closeStrategy) {
					const named = openStrategy || closeStrategy;
					if (!nameOf(openStrategy ? execution?.orderId : lot.orderId)) addResidual(residual, RESIDUAL_REASONS.MANUAL_LEG, pnl);
					else if (plan.namedStrategies.size > 1) addResidual(residual, RESIDUAL_REASONS.DETACHED_EXIT, pnl);
					else {
						credit(named);
						detachedPairs += 1;
					}
				} else addResidual(residual, RESIDUAL_REASONS.NO_STRATEGY, pnl);
			}
			lot.qty -= take;
			remaining -= take;
			if (lot.qty <= 1e-9) book.shift();
		}
		if (remaining > 0) book.push({
			side,
			qty: remaining,
			price,
			orderId: execution?.orderId || "",
			strategyName: ""
		});
		const nextPosition = num$1(runningPosition.get(instrument)) + side * filled;
		runningPosition.set(instrument, nextPosition);
		if (stated != null && Math.abs(nextPosition - stated) > 1e-9) positionAgrees = false;
	}
	const openContracts = [...books.values()].reduce((total, book) => total + book.reduce((n, lot) => n + lot.qty, 0), 0);
	const byStrategy = [...attributed.entries()].map(([strategyName, row]) => ({
		strategyName,
		realized: Math.round(row.realized * 100) / 100,
		pairs: row.pairs
	})).sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized) || a.strategyName.localeCompare(b.strategyName));
	residual.realized = Math.round(residual.realized * 100) / 100;
	attributedTotal = Math.round(attributedTotal * 100) / 100;
	derivedTotal = Math.round(derivedTotal * 100) / 100;
	const reconciles = reportedGross != null && Math.abs(derivedTotal - num$1(reportedGross)) <= tolerance;
	const complete = reconciles && residual.pairs === 0 && unpricedPairs === 0 && !unknownInstruments.size && positionAgrees;
	const status = refusedBooks.length ? "refused" : reportedGross == null ? "no-reported-gross" : complete ? "exact" : reconciles ? "partial" : "unreconciled";
	return {
		byStrategy,
		residual,
		attributedTotal,
		derivedTotal,
		reportedGross,
		difference: reportedGross == null ? null : Math.round((derivedTotal - num$1(reportedGross)) * 100) / 100,
		pairs,
		unpricedPairs,
		detachedPairs,
		openContracts,
		carriedInContracts,
		refusedBooks,
		unknownInstruments: [...unknownInstruments].filter(Boolean).sort(),
		carryInBasis: normalizedCarryIn.available ? "prior-close" : normalizedCarryIn.reason || "no-history",
		orderingBasis: basis,
		positionAgrees,
		reconciles,
		status
	};
}
/**
* Same derivation, run once per account over a whole day's grids.
*
* Keying is (account, strategy) throughout: the returned map is per account and
* each account's strategies are derived only from that account's own fills. A
* single flat map keyed on strategy name would smear one account's money across
* every row sharing the name — measured at 13 of 47 rows on the real export.
*
* `carryInByAccount` is what the caller knows about each account's previous
* close, keyed by account name. A caller with no history passes nothing and
* every carried-in book is refused — which is the correct answer for a caller
* that cannot see yesterday, and the wrong one for a caller that can. See
* carryForwardLots.js.
*/
function deriveStrategyPnlByAccount({ executions = [], orders = [], accounts = [], carryInByAccount = null, tolerance = DEFAULT_TOLERANCE } = {}) {
	const grossByAccount = /* @__PURE__ */ new Map();
	for (const account of accounts || []) {
		const name = String(account?.accountName || "").trim();
		if (!name) continue;
		const gross = account?.grossRealizedPnlReported;
		grossByAccount.set(name, gross === void 0 ? null : gross);
	}
	const execsByAccount = /* @__PURE__ */ new Map();
	for (const execution of executions || []) {
		const name = String(execution?.accountName || "").trim();
		if (!name) continue;
		if (!execsByAccount.has(name)) execsByAccount.set(name, []);
		execsByAccount.get(name).push(execution);
	}
	const ordersByAccount = /* @__PURE__ */ new Map();
	for (const order of orders || []) {
		const name = String(order?.accountName || "").trim();
		if (!name) continue;
		if (!ordersByAccount.has(name)) ordersByAccount.set(name, []);
		ordersByAccount.get(name).push(order);
	}
	const carryInFor = (name) => {
		if (!carryInByAccount) return null;
		if (typeof carryInByAccount.get === "function") return carryInByAccount.get(name) || null;
		return carryInByAccount[name] || null;
	};
	const result = /* @__PURE__ */ new Map();
	for (const name of /* @__PURE__ */ new Set([...grossByAccount.keys(), ...execsByAccount.keys()])) result.set(name, deriveStrategyPnl({
		executions: execsByAccount.get(name) || [],
		orders: ordersByAccount.get(name) || [],
		reportedGross: grossByAccount.has(name) ? grossByAccount.get(name) : null,
		carryIn: carryInFor(name),
		tolerance
	}));
	return result;
}
//#endregion
//#region src/domain/carryForwardLots.js
var CARRY_IN_REASONS = {
	NO_HISTORY: "no-history",
	GAP: "gap"
};
var num = (value) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
};
var signedQty = (execution) => (/^buy/i.test(String(execution?.action || "")) ? 1 : -1) * Math.abs(num(execution?.quantity));
/**
* Replay one close's fills for one account onto a running per-instrument book.
*
* Returns the reason the account's carry-in became unusable, or '' if it stayed
* usable. The book is mutated in place either way: the quantities stay honest
* even when the prices stop being, so a later day's Position check still lines
* up and reports a gap rather than a silently short book.
*/
function replayAccountDay(book, executions, strategyByOrderId) {
	const { ordered } = orderExecutions(executions);
	const byInstrument = /* @__PURE__ */ new Map();
	for (const execution of ordered) {
		const instrument = String(execution?.instrument || "").trim();
		if (!byInstrument.has(instrument)) byInstrument.set(instrument, []);
		byInstrument.get(instrument).push(execution);
	}
	let broken = "";
	for (const [instrument, fills] of byInstrument) {
		if (!book.has(instrument)) book.set(instrument, []);
		const lots = book.get(instrument);
		const held = lots.reduce((total, lot) => total + lot.side * lot.qty, 0);
		const statedFirst = parsePosition(fills[0]?.position);
		const impliedStart = statedFirst == null ? null : statedFirst - signedQty(fills[0]);
		const needs = impliedStart == null ? isExitFill(fills[0]) ? null : 0 : impliedStart;
		if (needs == null || Math.abs(needs - held) > 1e-9) {
			broken = CARRY_IN_REASONS.GAP;
			if (needs != null && needs !== held) {
				const missing = needs - held;
				lots.push({
					side: missing > 0 ? 1 : -1,
					qty: Math.abs(missing),
					price: null,
					strategyName: ""
				});
			}
		}
		for (const execution of fills) {
			const side = /^buy/i.test(String(execution?.action || "")) ? 1 : -1;
			const price = num(execution?.price);
			let remaining = Math.abs(num(execution?.quantity));
			while (remaining > 0 && lots.length && lots[0].side !== side) {
				const take = Math.min(remaining, lots[0].qty);
				lots[0].qty -= take;
				remaining -= take;
				if (lots[0].qty <= 1e-9) lots.shift();
			}
			if (remaining > 0) lots.push({
				side,
				qty: remaining,
				price,
				strategyName: strategyByOrderId.get(String(execution?.orderId || "").trim()) || ""
			});
		}
	}
	return broken;
}
/**
* Open lots per account at the last stored close before `date`.
*
* @param {object[]} dailyImports the client's stored closes, each
*        `{ date, executions, orders }`. Closes on or after `date` are ignored,
*        so a re-import of the same day cannot feed itself.
* @param {string} date the trading date being derived.
* @returns {{ byAccount: Map<string, object>, priorDate: string|null, days: number }}
*          Each entry is the `carryIn` shape deriveStrategyPnl accepts:
*          `{ available, reason, priorDate, lots }`. An account with no stored
*          close is simply absent from the map — deriveStrategyPnl reads that
*          as 'no-history', which is what it is.
*/
function carryForwardLots({ dailyImports = [], date } = {}) {
	const prior = (dailyImports || []).filter((entry) => entry && entry.date && String(entry.date) < String(date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
	const byAccount = /* @__PURE__ */ new Map();
	if (!prior.length) return {
		byAccount,
		priorDate: null,
		days: 0
	};
	const books = /* @__PURE__ */ new Map();
	const broken = /* @__PURE__ */ new Map();
	for (const close of prior) {
		const strategyByOrderId = new Map((close.orders || []).map((order) => [String(order?.id || "").trim(), String(order?.strategyName || "").trim()]));
		const byAccountExecutions = /* @__PURE__ */ new Map();
		for (const execution of close.executions || []) {
			const name = String(execution?.accountName || "").trim();
			if (!name) continue;
			if (!byAccountExecutions.has(name)) byAccountExecutions.set(name, []);
			byAccountExecutions.get(name).push(execution);
		}
		for (const [name, executions] of byAccountExecutions) {
			if (!books.has(name)) books.set(name, /* @__PURE__ */ new Map());
			const reason = replayAccountDay(books.get(name), executions, strategyByOrderId);
			if (reason && !broken.has(name)) broken.set(name, reason);
		}
	}
	const priorDate = String(prior[prior.length - 1].date);
	for (const [name, book] of books) {
		const lots = [];
		for (const [instrument, instrumentLots] of book) for (const lot of instrumentLots) {
			if (lot.qty <= 1e-9) continue;
			lots.push({
				instrument,
				side: lot.side,
				qty: lot.qty,
				price: lot.price,
				strategyName: lot.strategyName
			});
		}
		const reason = broken.get(name) || "";
		byAccount.set(name, {
			available: !reason,
			reason,
			priorDate,
			lots
		});
	}
	return {
		byAccount,
		priorDate,
		days: prior.length
	};
}
//#endregion
//#region src/domain/joinDerivedStrategies.js
var JOIN_STATUS = {
	EXACT: "exact",
	INCOMPLETE: "incomplete",
	AMBIGUOUS: "ambiguous",
	OFF_ROSTER: "off-roster",
	UNBALANCED: "unbalanced",
	UNAVAILABLE: "unavailable"
};
var ROW_JOIN = {
	MATCHED: "matched",
	NO_DERIVED_ROW: "no-derived-row",
	AMBIGUOUS_NAME: "ambiguous-name",
	REFUSED: "refused",
	UNAVAILABLE: "unavailable"
};
var name = (value) => String(value ?? "").trim();
var round2$1 = (value) => Math.round(Number(value) * 100) / 100;
/**
* Carry an account's derived per-strategy figures onto that account's grid rows.
*
* @param {object[]} strategies ONE account's Strategies-grid rows.
* @param {object|null} derivation that same account's deriveStrategyPnl result.
* @param {number} tolerance per-row rounding slack for the sum check.
* @returns {{strategies: object[], join: object}} the rows with
*   `derivedRealized` and `derivedRealizedJoin` set, and the join report —
*   including any derived money that reached no row. Only `derivedRealized` is
*   persisted; see ROW_JOIN above for why the reason is not.
*/
function joinDerivedStrategies({ strategies = [], derivation = null, tolerance = DEFAULT_TOLERANCE } = {}) {
	const roster = Array.isArray(strategies) ? strategies : [];
	const hasDerivation = derivation?.status === "exact" && Array.isArray(derivation.byStrategy);
	const derivedRows = hasDerivation ? derivation.byStrategy : [];
	const rosterCountByName = /* @__PURE__ */ new Map();
	for (const strategy of roster) {
		const key = name(strategy?.strategyName);
		rosterCountByName.set(key, (rosterCountByName.get(key) || 0) + 1);
	}
	const matchedByName = /* @__PURE__ */ new Map();
	const ambiguousNames = [];
	const offRoster = [];
	let joinedTotal = 0;
	let offRosterRealized = 0;
	for (const row of derivedRows) {
		const key = name(row?.strategyName);
		const count = rosterCountByName.get(key) || 0;
		const realized = Number(row?.realized) || 0;
		if (count > 1) ambiguousNames.push(key);
		else if (count === 1) {
			matchedByName.set(key, realized);
			joinedTotal += realized;
		} else {
			offRoster.push({
				strategyName: key,
				realized
			});
			offRosterRealized += realized;
		}
	}
	const unmatchedRoster = [...rosterCountByName.keys()].filter((key) => !matchedByName.has(key) && !ambiguousNames.includes(key));
	const reportedGross = derivation && derivation.reportedGross != null ? Number(derivation.reportedGross) : null;
	joinedTotal = round2$1(joinedTotal);
	offRosterRealized = round2$1(offRosterRealized);
	const slack = Math.max(Number(tolerance) || 0, .01 * (matchedByName.size + 1));
	const balanced = hasDerivation && reportedGross != null && Math.abs(joinedTotal - reportedGross) <= slack;
	const published = hasDerivation && balanced && ambiguousNames.length === 0;
	const status = !hasDerivation ? JOIN_STATUS.UNAVAILABLE : ambiguousNames.length ? JOIN_STATUS.AMBIGUOUS : !balanced ? offRoster.length ? JOIN_STATUS.OFF_ROSTER : JOIN_STATUS.UNBALANCED : offRoster.length ? JOIN_STATUS.OFF_ROSTER : unmatchedRoster.length ? JOIN_STATUS.INCOMPLETE : JOIN_STATUS.EXACT;
	return {
		strategies: roster.map((strategy) => {
			const key = name(strategy?.strategyName);
			let rowJoin = ROW_JOIN.UNAVAILABLE;
			if (hasDerivation) if (ambiguousNames.includes(key)) rowJoin = ROW_JOIN.AMBIGUOUS_NAME;
			else if (!published) rowJoin = ROW_JOIN.REFUSED;
			else if (matchedByName.has(key)) rowJoin = ROW_JOIN.MATCHED;
			else rowJoin = ROW_JOIN.NO_DERIVED_ROW;
			return {
				...strategy,
				derivedRealized: rowJoin === ROW_JOIN.MATCHED ? matchedByName.get(key) : null,
				derivedRealizedJoin: rowJoin
			};
		}),
		join: {
			status,
			published,
			rosterRows: roster.length,
			derivedRows: derivedRows.length,
			matchedRows: published ? matchedByName.size : 0,
			ambiguousNames: [...new Set(ambiguousNames)].sort(),
			unmatchedRoster: unmatchedRoster.sort(),
			offRoster: offRoster.sort((a, b) => a.strategyName.localeCompare(b.strategyName)),
			offRosterRealized,
			joinedTotal,
			reportedGross,
			difference: reportedGross == null ? null : round2$1(joinedTotal - reportedGross),
			balanced
		}
	};
}
//#endregion
//#region src/domain/strategyFamily.js
/**
* The family a strategy belongs to: `0 - OGX-PF-2.4` → `OGX-PF`.
*
* The leading number is the NinjaTrader grid's row index, not part of the name.
* The trailing version is what the team versions and swaps; grouping by the
* full name would split one family into a row per version and hide the size of
* the exposure.
*
* A version is only stripped when it has a dot, matching parseStrategyVersion
* in csvImport. `-PF` is a different product from its non-PF sibling — separate
* prop-firm rules — so it stays.
*/
function strategyFamilyOf(strategyName) {
	return String(strategyName || "").trim().replace(/^\d+\s*-\s*/, "").replace(/\s*-\s*\d+(?:\.\d+)+\s*$/, "").trim() || null;
}
/* @license
Papa Parse
v5.5.4
https://github.com/mholt/PapaParse
License: MIT
*/
(/* @__PURE__ */ __commonJSMin(((exports, module) => {
	((e, t) => {
		"function" == typeof define && define.amd ? define([], t) : "object" == typeof module && "undefined" != typeof exports ? module.exports = t() : e.Papa = t();
	})(exports, function r() {
		var n = "undefined" != typeof self ? self : "undefined" != typeof window ? window : void 0 !== n ? n : {};
		var d, s = !n.document && !!n.postMessage, a = n.IS_PAPA_WORKER || !1, o = {}, h = 0, v = {};
		function P(e) {
			return 65279 === e.charCodeAt(0) ? e.slice(1) : e;
		}
		function u(e) {
			this._handle = null, this._finished = !1, this._completed = !1, this._halted = !1, this._input = null, this._baseIndex = 0, this._partialLine = "", this._rowCount = 0, this._start = 0, this._nextChunk = null, this.isFirstChunk = !0, this._completeResults = {
				data: [],
				errors: [],
				meta: {}
			}, function(e) {
				var t = b(e);
				t.chunkSize = parseInt(t.chunkSize), e.step || e.chunk || (t.chunkSize = null);
				this._handle = new i(t), (this._handle.streamer = this)._config = t;
			}.call(this, e), this.parseChunk = function(t, e) {
				var i = parseInt(this._config.skipFirstNLines) || 0;
				if (this.isFirstChunk && 0 < i) {
					let e = this._config.newline;
					e || (r = this._config.quoteChar || "\"", e = this._handle.guessLineEndings(t, r)), t = [...t.split(e).slice(i)].join(e);
				}
				this.isFirstChunk && q(this._config.beforeFirstChunk) && void 0 !== (r = this._config.beforeFirstChunk(t)) && (t = r), this.isFirstChunk = !1, this._halted = !1;
				var i = this._partialLine + t, r = (this._partialLine = "", this._handle.parse(i, this._baseIndex, !this._finished));
				if (!this._handle.paused() && !this._handle.aborted()) {
					t = r.meta.cursor, i = (this._finished || (this._partialLine = i.substring(t - this._baseIndex), this._baseIndex = t), r && r.data && (this._rowCount += r.data.length), this._finished || this._config.preview && this._rowCount >= this._config.preview);
					if (a) n.postMessage({
						results: r,
						workerId: v.WORKER_ID,
						finished: i
					});
					else if (q(this._config.chunk) && !e) {
						if (this._config.chunk(r, this._handle), this._handle.paused() || this._handle.aborted()) return void (this._halted = !0);
						this._completeResults = r = void 0;
					}
					return this._config.step || this._config.chunk || (this._completeResults.data = this._completeResults.data.concat(r.data), this._completeResults.errors = this._completeResults.errors.concat(r.errors), this._completeResults.meta = r.meta), this._completed || !i || !q(this._config.complete) || r && r.meta.aborted || (this._config.complete(this._completeResults, this._input), this._completed = !0), i || r && r.meta.paused || this._nextChunk(), r;
				}
				this._halted = !0;
			}, this._sendError = function(e) {
				q(this._config.error) ? this._config.error(e) : a && this._config.error && n.postMessage({
					workerId: v.WORKER_ID,
					error: e,
					finished: !1
				});
			};
		}
		function f(e) {
			var r;
			(e = e || {}).chunkSize || (e.chunkSize = v.RemoteChunkSize), u.call(this, e), this._nextChunk = s ? function() {
				this._readChunk(), this._chunkLoaded();
			} : function() {
				this._readChunk();
			}, this.stream = function(e) {
				this._input = e, this._nextChunk();
			}, this._readChunk = function() {
				if (this._finished) this._chunkLoaded();
				else {
					if (r = new XMLHttpRequest(), this._config.withCredentials && (r.withCredentials = this._config.withCredentials), s || (r.onload = y(this._chunkLoaded, this), r.onerror = y(this._chunkError, this)), r.open(this._config.downloadRequestBody ? "POST" : "GET", this._input, !s), this._config.downloadRequestHeaders) {
						var e, t = this._config.downloadRequestHeaders;
						for (e in t) r.setRequestHeader(e, t[e]);
					}
					var i;
					this._config.chunkSize && (i = this._start + this._config.chunkSize - 1, r.setRequestHeader("Range", "bytes=" + this._start + "-" + i));
					try {
						r.send(this._config.downloadRequestBody);
					} catch (e) {
						this._chunkError(e.message);
					}
					s && 0 === r.status && this._chunkError();
				}
			}, this._chunkLoaded = function() {
				4 === r.readyState && (r.status < 200 || 400 <= r.status ? this._chunkError() : (this._start += this._config.chunkSize || r.responseText.length, this._finished = !this._config.chunkSize || this._start >= ((e) => null !== (e = e.getResponseHeader("Content-Range")) ? parseInt(e.substring(e.lastIndexOf("/") + 1)) : -1)(r), this.parseChunk(r.responseText)));
			}, this._chunkError = function(e) {
				e = r.statusText || e;
				this._sendError(new Error(e));
			};
		}
		function l(e) {
			(e = e || {}).chunkSize || (e.chunkSize = v.LocalChunkSize), u.call(this, e);
			var i, r, n = "undefined" != typeof FileReader;
			this.stream = function(e) {
				this._input = e, r = e.slice || e.webkitSlice || e.mozSlice, n ? ((i = new FileReader()).onload = y(this._chunkLoaded, this), i.onerror = y(this._chunkError, this)) : i = new FileReaderSync(), this._nextChunk();
			}, this._nextChunk = function() {
				this._finished || this._config.preview && !(this._rowCount < this._config.preview) || this._readChunk();
			}, this._readChunk = function() {
				var e = this._input, t = (this._config.chunkSize && (t = Math.min(this._start + this._config.chunkSize, this._input.size), e = r.call(e, this._start, t)), i.readAsText(e, this._config.encoding));
				n || this._chunkLoaded({ target: { result: t } });
			}, this._chunkLoaded = function(e) {
				this._start += this._config.chunkSize, this._finished = !this._config.chunkSize || this._start >= this._input.size, this.parseChunk(e.target.result);
			}, this._chunkError = function() {
				this._sendError(i.error);
			};
		}
		function c(e) {
			var i;
			u.call(this, e = e || {}), this.stream = function(e) {
				return i = e, this._nextChunk();
			}, this._nextChunk = function() {
				var e, t;
				if (!this._finished) return e = this._config.chunkSize, i = e ? (t = i.substring(0, e), i.substring(e)) : (t = i, ""), this._finished = !i, this.parseChunk(t);
			};
		}
		function p(e) {
			u.call(this, e = e || {});
			var t = [], i = !0, r = !1;
			this.pause = function() {
				u.prototype.pause.apply(this, arguments), this._input.pause();
			}, this.resume = function() {
				u.prototype.resume.apply(this, arguments), this._input.resume();
			}, this.stream = function(e) {
				this._input = e, this._input.on("data", this._streamData), this._input.on("end", this._streamEnd), this._input.on("error", this._streamError);
			}, this._checkIsFinished = function() {
				r && 1 === t.length && (this._finished = !0);
			}, this._nextChunk = function() {
				this._checkIsFinished(), t.length ? this.parseChunk(t.shift()) : i = !0;
			}, this._streamData = y(function(e) {
				try {
					t.push("string" == typeof e ? e : e.toString(this._config.encoding)), i && (i = !1, this._checkIsFinished(), this.parseChunk(t.shift()));
				} catch (e) {
					this._streamError(e);
				}
			}, this), this._streamError = y(function(e) {
				this._streamCleanUp(), this._sendError(e);
			}, this), this._streamEnd = y(function() {
				this._streamCleanUp(), r = !0, this._streamData("");
			}, this), this._streamCleanUp = y(function() {
				this._input.removeListener("data", this._streamData), this._input.removeListener("end", this._streamEnd), this._input.removeListener("error", this._streamError);
			}, this);
		}
		function i(m) {
			var n, s, a, t, o = Math.pow(2, 53), h = -o, u = /^\s*-?(\d+\.?|\.\d+|\d+\.\d+)([eE][-+]?\d+)?\s*$/, d = /^((\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z)))$/, i = this, r = 0, f = 0, l = !1, e = !1, c = [], p = {
				data: [],
				errors: [],
				meta: {}
			};
			function y(e) {
				return "greedy" === m.skipEmptyLines ? "" === e.join("").trim() : 1 === e.length && 0 === e[0].length;
			}
			function g() {
				if (p && a && (k("Delimiter", "UndetectableDelimiter", "Unable to auto-detect delimiting character; defaulted to '" + v.DefaultDelimiter + "'"), a = !1), m.skipEmptyLines && (p.data = p.data.filter(function(e) {
					return !y(e);
				})), _()) {
					if (p) if (Array.isArray(p.data[0])) {
						for (var e = 0; _() && e < p.data.length; e++) p.data[e].forEach(t);
						p.data.splice(0, 1);
					} else p.data.forEach(t);
					function t(e, t) {
						e = P(e), q(m.transformHeader) && (e = m.transformHeader(e, t)), c.push(e);
					}
				}
				function i(e, t) {
					for (var i = m.header ? {} : [], r = 0; r < e.length; r++) {
						var n = r, s = e[r], s = ((e, t) => ((e) => (m.dynamicTypingFunction && void 0 === m.dynamicTyping[e] && (m.dynamicTyping[e] = m.dynamicTypingFunction(e)), !0 === (m.dynamicTyping[e] || m.dynamicTyping)))(e) ? "true" === t || "TRUE" === t || "false" !== t && "FALSE" !== t && (((e) => {
							if (u.test(e)) {
								e = parseFloat(e);
								if (h < e && e < o) return 1;
							}
						})(t) ? parseFloat(t) : d.test(t) ? new Date(t) : "" === t ? null : t) : t)(n = m.header ? r >= c.length ? "__parsed_extra" : c[r] : n, s = m.transform ? m.transform(s, n) : s);
						"__parsed_extra" === n ? (i[n] = i[n] || [], i[n].push(s)) : i[n] = s;
					}
					return m.header && (r > c.length ? k("FieldMismatch", "TooManyFields", "Too many fields: expected " + c.length + " fields but parsed " + r, f + t) : r < c.length && k("FieldMismatch", "TooFewFields", "Too few fields: expected " + c.length + " fields but parsed " + r, f + t)), i;
				}
				var r;
				p && (m.header || m.dynamicTyping || m.transform) && (r = 1, !p.data.length || Array.isArray(p.data[0]) ? (p.data = p.data.map(i), r = p.data.length) : p.data = i(p.data, 0), m.header && p.meta && (p.meta.fields = c), f += r);
			}
			function _() {
				return m.header && 0 === c.length;
			}
			function k(e, t, i, r) {
				e = {
					type: e,
					code: t,
					message: i
				};
				void 0 !== r && (e.row = r), p.errors.push(e);
			}
			q(m.step) && (t = m.step, m.step = function(e) {
				p = e, _() ? g() : (g(), 0 !== p.data.length && (r += e.data.length, m.preview && r > m.preview ? s.abort() : (p.data = p.data[0], t(p, i))));
			}), this.parse = function(e, t, i) {
				var r = m.quoteChar || "\"", r = (m.newline || (m.newline = this.guessLineEndings(e, r)), a = !1, m.delimiter ? q(m.delimiter) && (m.delimiter = m.delimiter(e), p.meta.delimiter = m.delimiter) : ((r = ((e, t, i, r, n) => {
					var s, a, o, h;
					n = n || [
						",",
						"	",
						"|",
						";",
						v.RECORD_SEP,
						v.UNIT_SEP
					];
					for (var u = 0; u < n.length; u++) {
						for (var d, f = n[u], l = 0, c = 0, p = 0, g = (o = void 0, new E({
							comments: r,
							delimiter: f,
							newline: t,
							preview: 10
						}).parse(e)), _ = 0; _ < g.data.length; _++) i && y(g.data[_]) ? p++ : (d = g.data[_].length, c += d, void 0 === o ? o = d : 0 < d && (l += Math.abs(d - o), o = d));
						0 < g.data.length && (c /= g.data.length - p), (void 0 === a || l <= a) && (void 0 === h || h < c) && 1.99 < c && (a = l, s = f, h = c);
					}
					return {
						successful: !!(m.delimiter = s),
						bestDelimiter: s
					};
				})(e, m.newline, m.skipEmptyLines, m.comments, m.delimitersToGuess)).successful ? m.delimiter = r.bestDelimiter : (a = !0, m.delimiter = v.DefaultDelimiter), p.meta.delimiter = m.delimiter), b(m));
				return m.preview && m.header && r.preview++, n = e, s = new E(r), p = s.parse(n, t, i), g(), l ? { meta: { paused: !0 } } : p || { meta: { paused: !1 } };
			}, this.paused = function() {
				return l;
			}, this.pause = function() {
				l = !0, s.abort(), n = q(m.chunk) ? "" : n.substring(s.getCharIndex());
			}, this.resume = function() {
				i.streamer._halted ? (l = !1, i.streamer.parseChunk(n, !0)) : setTimeout(i.resume, 3);
			}, this.aborted = function() {
				return e;
			}, this.abort = function() {
				e = !0, s.abort(), p.meta.aborted = !0, q(m.complete) && m.complete(p), n = "";
			}, this.guessLineEndings = function(e, t) {
				e = e.substring(0, 1048576);
				var t = new RegExp(U(t) + "([^]*?)" + U(t), "gm"), i = (e = e.replace(t, "")).split("\r"), t = e.split("\n"), e = 1 < t.length && t[0].length < i[0].length;
				if (1 === i.length || e) return "\n";
				for (var r = 0, n = 0; n < i.length; n++) "\n" === i[n][0] && r++;
				return r >= i.length / 2 ? "\r\n" : "\r";
			};
		}
		function U(e) {
			return e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
		function E(C) {
			var S = (C = C || {}).delimiter, O = C.newline, x = C.comments, I = C.step, A = C.preview, T = C.fastMode, D = null, L = !1, F = null == C.quoteChar ? "\"" : C.quoteChar, j = F;
			if (void 0 !== C.escapeChar && (j = C.escapeChar), ("string" != typeof S || -1 < v.BAD_DELIMITERS.indexOf(S)) && (S = ","), x === S) throw new Error("Comment character same as delimiter");
			!0 === x ? x = "#" : ("string" != typeof x || -1 < v.BAD_DELIMITERS.indexOf(x)) && (x = !1), "\n" !== O && "\r" !== O && "\r\n" !== O && (O = "\n");
			var z = 0, M = !1;
			this.parse = function(i, t, r) {
				if ("string" != typeof i) throw new Error("Input must be a string");
				var n = i.length, e = S.length, s = O.length, a = x.length, o = q(I), h = [], u = [], d = [], f = z = 0;
				if (!i) return w();
				if (T || !1 !== T && -1 === i.indexOf(F)) {
					for (var l = i.split(O), c = 0; c < l.length; c++) {
						if (d = l[c], z += d.length, c !== l.length - 1) z += O.length;
						else if (r) return w();
						if (!x || d.substring(0, a) !== x) {
							if (o) {
								if (h = [], k(d.split(S)), R(), M) return w();
							} else k(d.split(S));
							if (A && A <= c) return h = h.slice(0, A), w(!0);
						}
					}
					return w();
				}
				for (var p = i.indexOf(S, z), g = i.indexOf(O, z), _ = new RegExp(U(j) + U(F), "g"), m = i.indexOf(F, z);;) if (i[z] === F) for (m = z, z++;;) {
					if (-1 === (m = i.indexOf(F, m + 1))) return r || u.push({
						type: "Quotes",
						code: "MissingQuotes",
						message: "Quoted field unterminated",
						row: h.length,
						index: z
					}), E();
					if (m === n - 1) return E(i.substring(z, m).replace(_, F));
					if (F === j && i[m + 1] === j) m++;
					else if (F === j || 0 === m || i[m - 1] !== j) {
						-1 !== p && p < m + 1 && (p = i.indexOf(S, m + 1));
						var y = v(-1 === (g = -1 !== g && g < m + 1 ? i.indexOf(O, m + 1) : g) ? p : Math.min(p, g));
						if (i.substr(m + 1 + y, e) === S) {
							d.push(i.substring(z, m).replace(_, F)), i[z = m + 1 + y + e] !== F && (m = i.indexOf(F, z)), p = i.indexOf(S, z), g = i.indexOf(O, z);
							break;
						}
						y = v(g);
						if (i.substring(m + 1 + y, m + 1 + y + s) === O) {
							if (d.push(i.substring(z, m).replace(_, F)), b(m + 1 + y + s), p = i.indexOf(S, z), m = i.indexOf(F, z), o && (R(), M)) return w();
							if (A && h.length >= A) return w(!0);
							break;
						}
						u.push({
							type: "Quotes",
							code: "InvalidQuotes",
							message: "Trailing quote on quoted field is malformed",
							row: h.length,
							index: z
						}), m++;
					}
				}
				else if (x && 0 === d.length && i.substring(z, z + a) === x) {
					if (-1 === g) return w();
					z = g + s, g = i.indexOf(O, z), p = i.indexOf(S, z);
				} else if (-1 !== p && (p < g || -1 === g)) d.push(i.substring(z, p)), z = p + e, p = i.indexOf(S, z);
				else {
					if (-1 === g) break;
					if (d.push(i.substring(z, g)), b(g + s), o && (R(), M)) return w();
					if (A && h.length >= A) return w(!0);
				}
				return E();
				function k(e) {
					h.push(e), f = z;
				}
				function v(e) {
					var t = 0;
					return t = -1 !== e && (e = i.substring(m + 1, e)) && "" === e.trim() ? e.length : t;
				}
				function E(e) {
					return r || (void 0 === e && (e = i.substring(z)), d.push(e), z = n, k(d), o && R()), w();
				}
				function b(e) {
					z = e, k(d), d = [], g = i.indexOf(O, z);
				}
				function w(e) {
					if (C.header && !t && h.length && !L) {
						var s = h[0], a = Object.create(null), o = new Set(s);
						let n = !1;
						for (let r = 0; r < s.length; r++) {
							let i = P(s[r]);
							if (a[i = q(C.transformHeader) ? C.transformHeader(i, r) : i]) {
								let e, t = a[i];
								for (; e = i + "_" + t, t++, o.has(e););
								o.add(e), s[r] = e, a[i]++, n = !0, (D = null === D ? {} : D)[e] = i;
							} else a[i] = 1, s[r] = i;
							o.add(i);
						}
						n && console.warn("Duplicate headers found and renamed."), L = !0;
					}
					return {
						data: h,
						errors: u,
						meta: {
							delimiter: S,
							linebreak: O,
							aborted: M,
							truncated: !!e,
							cursor: f + (t || 0),
							renamedHeaders: D
						}
					};
				}
				function R() {
					I(w()), h = [], u = [];
				}
			}, this.abort = function() {
				M = !0;
			}, this.getCharIndex = function() {
				return z;
			};
		}
		function g(e) {
			var t = e.data, i = o[t.workerId], r = !1;
			if (t.error) i.userError(t.error, t.file);
			else if (t.results && t.results.data) {
				var n = {
					abort: function() {
						r = !0, _(t.workerId, {
							data: [],
							errors: [],
							meta: { aborted: !0 }
						});
					},
					pause: m,
					resume: m
				};
				if (q(i.userStep)) {
					for (var s = 0; s < t.results.data.length && (i.userStep({
						data: t.results.data[s],
						errors: t.results.errors,
						meta: t.results.meta
					}, n), !r); s++);
					delete t.results;
				} else q(i.userChunk) && (i.userChunk(t.results, n, t.file), delete t.results);
			}
			t.finished && !r && _(t.workerId, t.results);
		}
		function _(e, t) {
			var i = o[e];
			q(i.userComplete) && i.userComplete(t), i.terminate(), delete o[e];
		}
		function m() {
			throw new Error("Not implemented.");
		}
		function b(e) {
			if ("object" != typeof e || null === e) return e;
			var t, i = Array.isArray(e) ? [] : {};
			for (t in e) i[t] = b(e[t]);
			return i;
		}
		function y(e, t) {
			return function() {
				e.apply(t, arguments);
			};
		}
		function q(e) {
			return "function" == typeof e;
		}
		return v.parse = function(e, t) {
			var i = (t = t || {}).dynamicTyping || !1;
			q(i) && (t.dynamicTypingFunction = i, i = {});
			if (t.dynamicTyping = i, t.transform = !!q(t.transform) && t.transform, !t.worker || !v.WORKERS_SUPPORTED) return i = null, v.NODE_STREAM_INPUT, "string" == typeof e ? (e = P(e), i = new (t.download ? f : c)(t)) : !0 === e.readable && q(e.read) && q(e.on) ? i = new p(t) : (n.File && e instanceof File || e instanceof Object) && (i = new l(t)), i.stream(e);
			(i = (() => {
				var e;
				return !!v.WORKERS_SUPPORTED && (e = (() => {
					var e = n.URL || n.webkitURL || null, t = r.toString();
					return v.BLOB_URL || (v.BLOB_URL = e.createObjectURL(new Blob([
						"var global = (function() { if (typeof self !== 'undefined') { return self; } if (typeof window !== 'undefined') { return window; } if (typeof global !== 'undefined') { return global; } return {}; })(); global.IS_PAPA_WORKER=true; ",
						"(",
						t,
						")();"
					], { type: "text/javascript" })));
				})(), (e = new n.Worker(e)).onmessage = g, e.id = h++, o[e.id] = e);
			})()).userStep = t.step, i.userChunk = t.chunk, i.userComplete = t.complete, i.userError = t.error, t.step = q(t.step), t.chunk = q(t.chunk), t.complete = q(t.complete), t.error = q(t.error), delete t.worker, i.postMessage({
				input: e,
				config: t,
				workerId: i.id
			});
		}, v.unparse = function(e, t) {
			var s = !1, _ = !0, m = ",", y = "\r\n", a = "\"", o = a + a, i = !1, r = null, h = !1, u = ((() => {
				if ("object" == typeof t) {
					if ("string" != typeof t.delimiter || v.BAD_DELIMITERS.filter(function(e) {
						return -1 !== t.delimiter.indexOf(e);
					}).length || (m = t.delimiter), "boolean" != typeof t.quotes && "function" != typeof t.quotes && !Array.isArray(t.quotes) || (s = t.quotes), "boolean" != typeof t.skipEmptyLines && "string" != typeof t.skipEmptyLines || (i = t.skipEmptyLines), "string" == typeof t.newline && (y = t.newline), "string" == typeof t.quoteChar && (a = t.quoteChar, o = a + a), "boolean" == typeof t.header && (_ = t.header), Array.isArray(t.columns)) {
						if (0 === t.columns.length) throw new Error("Option columns is empty");
						r = t.columns;
					}
					void 0 !== t.escapeChar && (o = t.escapeChar + a), t.escapeFormulae instanceof RegExp ? h = t.escapeFormulae : "boolean" == typeof t.escapeFormulae && t.escapeFormulae && (h = /^[=+\-@\t\r].*$/);
				}
			})(), new RegExp(U(a), "g"));
			"string" == typeof e && (e = JSON.parse(e));
			if (Array.isArray(e)) {
				if (!e.length || Array.isArray(e[0])) return n(null, e, i);
				if ("object" == typeof e[0]) return n(r || Object.keys(e[0]), e, i);
			} else if ("object" == typeof e) return "string" == typeof e.data && (e.data = JSON.parse(e.data)), Array.isArray(e.data) && (e.fields || (e.fields = e.meta && e.meta.fields || r), e.fields || (e.fields = Array.isArray(e.data[0]) ? e.fields : "object" == typeof e.data[0] ? Object.keys(e.data[0]) : []), Array.isArray(e.data[0]) || "object" == typeof e.data[0] || (e.data = [e.data])), n(e.fields || [], e.data || [], i);
			throw new Error("Unable to serialize unrecognized input");
			function n(e, t, i) {
				var r = "", n = ("string" == typeof e && (e = JSON.parse(e)), "string" == typeof t && (t = JSON.parse(t)), Array.isArray(e) && 0 < e.length), s = !Array.isArray(t[0]);
				if (n && _) {
					for (var a = 0; a < e.length; a++) 0 < a && (r += m), r += k(e[a], a);
					0 < t.length && (r += y);
				}
				for (var o = 0; o < t.length; o++) {
					var h = (n ? e : t[o]).length, u = !1, d = n ? 0 === Object.keys(t[o]).length : 0 === t[o].length;
					if (i && !n && (u = "greedy" === i ? "" === t[o].join("").trim() : 1 === t[o].length && 0 === t[o][0].length), "greedy" === i && n) {
						for (var f = [], l = 0; l < h; l++) {
							var c = s ? e[l] : l;
							f.push(t[o][c]);
						}
						u = "" === f.join("").trim();
					}
					if (!u) {
						for (var p = 0; p < h; p++) {
							0 < p && !d && (r += m);
							var g = n && s ? e[p] : p;
							r += k(t[o][g], p);
						}
						o < t.length - 1 && (!i || 0 < h && !d) && (r += y);
					}
				}
				return r;
			}
			function k(e, t) {
				var i, r, n;
				return null == e ? "" : e.constructor === Date ? JSON.stringify(e).slice(1, 25) : (n = !1, h && "string" == typeof e && h.test(e) && (e = "'" + e, n = !0), r = (i = e.toString()).replace(u, o), (n = n || !0 === s || "function" == typeof s && s(e, t) || Array.isArray(s) && s[t] || ((e, t) => {
					for (var i = 0; i < t.length; i++) if (-1 < e.indexOf(t[i])) return !0;
					return !1;
				})(r, v.BAD_DELIMITERS) || -1 < r.indexOf(m) || -1 < i.indexOf(a) || " " === r.charAt(0) || " " === r.charAt(r.length - 1)) ? a + r + a : r);
			}
		}, v.RECORD_SEP = String.fromCharCode(30), v.UNIT_SEP = String.fromCharCode(31), v.BYTE_ORDER_MARK = "﻿", v.BAD_DELIMITERS = [
			"\r",
			"\n",
			"\"",
			v.BYTE_ORDER_MARK
		], v.WORKERS_SUPPORTED = !s && !!n.Worker, v.NODE_STREAM_INPUT = 1, v.LocalChunkSize = 10485760, v.RemoteChunkSize = 5242880, v.DefaultDelimiter = ",", v.Parser = E, v.ParserHandle = i, v.NetworkStreamer = f, v.FileStreamer = l, v.StringStreamer = c, v.ReadableStreamStreamer = p, n.jQuery && ((d = n.jQuery).fn.parse = function(o) {
			var i = o.config || {}, h = [];
			return this.each(function(e) {
				if (!("INPUT" === d(this).prop("tagName").toUpperCase() && "file" === d(this).attr("type").toLowerCase() && n.FileReader) || !this.files || 0 === this.files.length) return !0;
				for (var t = 0; t < this.files.length; t++) h.push({
					file: this.files[t],
					inputElem: this,
					instanceConfig: d.extend({}, i)
				});
			}), e(), this;
			function e() {
				if (0 === h.length) q(o.complete) && o.complete();
				else {
					var e, t, i, r, n = h[0];
					if (q(o.before)) {
						var s = o.before(n.file, n.inputElem);
						if ("object" == typeof s) {
							if ("abort" === s.action) return e = "AbortError", t = n.file, i = n.inputElem, r = s.reason, void (q(o.error) && o.error({ name: e }, t, i, r));
							if ("skip" === s.action) return void u();
							"object" == typeof s.config && (n.instanceConfig = d.extend(n.instanceConfig, s.config));
						} else if ("skip" === s) return void u();
					}
					var a = n.instanceConfig.complete;
					n.instanceConfig.complete = function(e) {
						q(a) && a(e, n.file, n.inputElem), u();
					}, v.parse(n.file, n.instanceConfig);
				}
			}
			function u() {
				h.splice(0, 1), e();
			}
		}), a && (n.onmessage = function(e) {
			e = e.data;
			void 0 === v.WORKER_ID && e && (v.WORKER_ID = e.workerId);
			"string" == typeof e.input ? n.postMessage({
				workerId: v.WORKER_ID,
				results: v.parse(e.input, e.config),
				finished: !0
			}) : (n.File && e.input instanceof File || e.input instanceof Object) && (e = v.parse(e.input, e.config)) && n.postMessage({
				workerId: v.WORKER_ID,
				results: e,
				finished: !0
			});
		}), (f.prototype = Object.create(u.prototype)).constructor = f, (l.prototype = Object.create(u.prototype)).constructor = l, (c.prototype = Object.create(c.prototype)).constructor = c, (p.prototype = Object.create(u.prototype)).constructor = p, v;
	});
})))();
var KNOWN_FAMILIES = [
	"ARPD",
	"B2X",
	"DJDR",
	"FSA",
	"IFSP",
	"MST",
	"OGX",
	"PLPI",
	"RBO",
	"SYFY",
	"TDC",
	"URGO"
];
function normalizeStrategyFamily(strategyName) {
	const cleaned = String(strategyName || "").replace(/^\d+\s*-\s*/, "").trim();
	if (/bullet\s*bot/i.test(cleaned)) return "Bullet Bot";
	const pfMatch = cleaned.match(/^([A-Z0-9]+)-PF\b/i);
	if (pfMatch) return `${pfMatch[1].toUpperCase()}_PF`;
	const [prefix] = cleaned.split("-");
	const token = prefix.trim().toUpperCase();
	if (KNOWN_FAMILIES.includes(token)) return token;
	if (token.endsWith("PF") && KNOWN_FAMILIES.includes(token.replace(/PF$/, ""))) return `${token.replace(/PF$/, "")}_PF`;
	return token || "Unknown";
}
function parseStrategyVersion(strategyName) {
	const match = String(strategyName || "").match(/-\s*(\d+(?:\.\d+)+)\s*$/);
	return match ? match[1] : "";
}
//#endregion
//#region src/domain/strategyRan.js
/** The four answers, strongest evidence first. */
var RAN_BASES = [
	"enabled",
	"fills",
	"realized",
	"none"
];
var lower$2 = (value) => String(value || "").toLowerCase();
/**
* The family a strategy NAME belongs to, by this product's one rule.
*
* The fills name a strategy the way the Strategies grid does (`0 - OGX-PF-2.4`)
* but the grid row stores its family as `OGX_PF`: strategyFamilyOf keeps the
* `-PF` and csvImport's normalizeStrategyFamily turns it into `_PF`. Measured
* over the stored book, this reproduces `strategy_snapshots.strategy_family` on
* all 3,805 rows, which is why the step 47 backfill is allowed to compute the
* family from the name on both sides of its join.
*/
function familyFromStrategyName(strategyName) {
	const family = strategyFamilyOf(strategyName);
	if (!family) return null;
	const pf = family.match(/^([A-Z0-9]+)-PF$/i);
	return pf ? `${pf[1].toUpperCase()}_PF` : family;
}
/** The family of one Strategies-grid row: what it stores, or its name. */
function familyOfStrategyRow(strategy) {
	return strategy?.strategyFamily || familyFromStrategyName(strategy?.strategyName) || null;
}
/**
* The families named on a set of fills, as `Map(family -> version)`.
*
* The version travels with the family because a family named ONLY on the fills
* (98 funded days on the book carried no strategy rows at all) has nowhere else
* to get one.
*/
function familiesOnFills(executions = []) {
	const families = /* @__PURE__ */ new Map();
	for (const execution of executions || []) {
		const family = familyFromStrategyName(execution?.strategyName);
		if (!family) continue;
		if (!families.has(family)) families.set(family, parseStrategyVersion(execution.strategyName));
	}
	return families;
}
/**
* THE RULE. One grid row against the families its own account's fills name.
*
* `filledFamilies` is what familiesOnFills returned for THIS account's fills on
* THIS close. Pass nothing and the fills cannot be consulted, which is not the
* same as their naming nothing: a caller with no fills on hand gets the answer
* the checkbox and the row's own realized can support, never a claim that the
* day was quiet.
*/
function ranBasisFromEvidence(strategy, filledFamilies = null) {
	if (strategy?.enabled === true) return "enabled";
	const family = familyOfStrategyRow(strategy);
	if (family && filledFamilies?.has(family)) return "fills";
	const realized = strategy?.realized;
	if (realized != null && Number(realized) !== 0) return "realized";
	return "none";
}
/** The stored answer if the row carries one this product recognises. */
function storedRanBasis(strategy) {
	const basis = strategy?.ranBasis;
	return RAN_BASES.includes(basis) ? basis : "";
}
/**
* What this row says about the day: the stored answer, or the rule.
*
* A row that carries `ran` without a basis (a writer that stored the boolean
* alone) is believed on the boolean and reported as `enabled` or `none`, which
* are the two answers a boolean can support.
*/
function ranBasisOf(strategy, filledFamilies = null) {
	const stored = storedRanBasis(strategy);
	if (stored) return stored;
	if (typeof strategy?.ran === "boolean") return strategy.ran ? "enabled" : "none";
	return ranBasisFromEvidence(strategy, filledFamilies);
}
/** Did this strategy run on its close. The one-line question a screen asks. */
function strategyRan(strategy, filledFamilies = null) {
	return ranBasisOf(strategy, filledFamilies) !== "none";
}
/**
* CAN THIS ROW'S "NO" BE BELIEVED WITHOUT THE CLOSE'S FILLS?
*
* `none` is the only answer of the four that needs evidence the caller may not
* hold. A row that is enabled, or that carries a stored answer from step 47,
* answers itself; a row that is none of those answers `none` only because the
* fills were never consulted, and that is not the same statement as "the day
* was quiet".
*
* It exists for Recalculate. A login carries no executions, so pressing it on a
* close whose fills have not arrived, on a database where step 47's backfill
* has not run, re-derived every row as `none` and wrote back the flags this
* product just spent a commit removing: `Expected strategy missing` Critical on
* real-money accounts that had traded all day, and `Strategy disabled` Warning
* once per row on each of them. A positive answer never needs this; only a
* negative one does.
*/
function ranAnswerIsKnown(strategy, { closeHasFills = true } = {}) {
	if (closeHasFills) return true;
	if (storedRanBasis(strategy) || typeof strategy?.ran === "boolean") return true;
	return strategy?.enabled === true;
}
/**
* The ingest side: every row of a close answered against that close's own fills.
*
* Returns a new array, row for row, each carrying `ran` and `ranBasis`. Fills
* are matched per ACCOUNT, by name, because a family running on one account of
* a client says nothing about the same family on another.
*
* A close that carries NO fills at all leaves a row's existing stored answer
* alone. An empty executions array is not evidence of a quiet day: the browser
* loads orders and executions after the first screen, and Recalculate runs on
* whatever it holds at the time. Without this, one Recalculate on a close whose
* trade history had not arrived would rewrite every `fills` row to `none` and
* flag the day as idle.
*
* `evidenceComplete` IS THE OTHER HALF OF THAT, FOR A ROW WITH NO STORED ANSWER.
*
* The guard above protects a row that already carries one. On a database where
* step 47 has run and `call public.backfill_strategy_ran_all();` has not yet
* finished, every row reads back `ran: null, ranBasis: ''`, so there is nothing
* to protect and the rule ran with no fills — which on a close exported after
* shutdown answers `none` for nearly every row. Pass `evidenceComplete: false`
* (which recalculateDailyImport does for a close whose fills a login did not
* carry) and such a row is left UNANSWERED rather than answered `none`. An
* unanswered row reads as `none` to anything that asks, which is the product's
* behaviour either way; what it does not do is let a caller mistake it for a
* measurement. See ranAnswerIsKnown, and reconcile.js's four flags.
*/
function withStrategyRan(strategies = [], executions = [], { evidenceComplete = true } = {}) {
	const byAccount = /* @__PURE__ */ new Map();
	for (const execution of executions || []) {
		const name = lower$2(execution?.accountName);
		if (!name) continue;
		if (!byAccount.has(name)) byAccount.set(name, []);
		byAccount.get(name).push(execution);
	}
	const filledByAccount = new Map([...byAccount.entries()].map(([name, rows]) => [name, familiesOnFills(rows)]));
	const closeHasFills = (executions || []).length > 0;
	return (strategies || []).map((strategy) => {
		if (!closeHasFills && (storedRanBasis(strategy) || typeof strategy?.ran === "boolean")) {
			const basis = ranBasisOf(strategy);
			return {
				...strategy,
				ran: basis !== "none",
				ranBasis: basis
			};
		}
		if (!closeHasFills && !evidenceComplete && !ranAnswerIsKnown(strategy, { closeHasFills: false })) return {
			...strategy,
			ran: strategy?.ran ?? null,
			ranBasis: strategy?.ranBasis || ""
		};
		const basis = ranBasisFromEvidence(strategy, filledByAccount.get(lower$2(strategy?.accountName)));
		return {
			...strategy,
			ran: basis !== "none",
			ranBasis: basis
		};
	});
}
//#endregion
//#region src/domain/propFirmRules.js
/** Sizes prop firms actually sell. */
var STANDARD_ACCOUNT_SIZES$1 = [
	5e3,
	1e4,
	25e3,
	5e4,
	75e3,
	1e5,
	15e4,
	25e4,
	3e5
];
/**
* The nearest standard size to a starting balance, or null.
*
* Balances drift the moment trading starts, so this only reads a balance from
* the earliest close on record and only accepts a match within a tolerance. A
* 50,000 account that opened at 50,000 is a 50k account; one sitting at 61,400
* is not any size we sell, and guessing would put an account under rules that
* were never its own.
*/
function inferAccountSize(balance, { tolerance = .15 } = {}) {
	const value = Number(balance);
	if (!Number.isFinite(value) || value <= 0) return null;
	let best = null;
	let bestDistance = Infinity;
	for (const size of STANDARD_ACCOUNT_SIZES$1) {
		const distance = Math.abs(value - size) / size;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = size;
		}
	}
	return bestDistance <= tolerance ? best : null;
}
/** Earliest balance on record for an account, which is the closest thing to its opening size. */
function firstObservedBalance(accountName, dailyImports = []) {
	const sorted = (dailyImports || []).filter((entry) => entry?.date).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
	for (const entry of sorted) for (const snapshot of entry.snapshots || []) {
		if (snapshot.accountName !== accountName) continue;
		const balance = Number(snapshot.accountBalance);
		if (Number.isFinite(balance) && balance > 0) return balance;
	}
	return null;
}
//#endregion
//#region src/domain/storedTarget.js
var STANDARD_ACCOUNT_SIZES = [
	5e4,
	1e5,
	15e4
];
var INFER_BAND = .2;
function inferStartingBalance(currentBalance) {
	const balance = Number(currentBalance);
	if (!Number.isFinite(balance) || balance <= 0) return null;
	for (const size of STANDARD_ACCOUNT_SIZES) if (Math.abs(balance - size) <= size * INFER_BAND) return size;
	return null;
}
/** Why a stored target is or is not used. */
var STORED_TARGET = {
	/** Above a known start: the reader uses it. */
	USABLE: "usable",
	/** Nothing stored. */
	NONE: "none",
	/** At or below the start it is judged against. */
	NOT_ABOVE_START: "not-above-start",
	/** No stored start, and the value sits on no standard size. */
	NO_START: "no-start"
};
var positive$1 = (value) => {
	if (value === "" || value == null) return null;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : null;
};
/**
* The verdict on one account's stored target.
*
* @param {object} meta a registry entry (`targetProfit`, `startBalance`)
* @returns {{ target: number|null, stored: number|null, judgedAgainst: number|null, state: string }}
*   `target` is the balance a reader may use, null when it may not.
*/
function storedTargetStatus(meta) {
	const stored = positive$1(meta?.targetProfit);
	if (stored == null) return {
		target: null,
		stored: null,
		judgedAgainst: null,
		state: STORED_TARGET.NONE
	};
	const judgedAgainst = positive$1(meta?.startBalance) ?? inferAccountSize(stored);
	if (judgedAgainst == null) return {
		target: null,
		stored,
		judgedAgainst: null,
		state: STORED_TARGET.NO_START
	};
	if (stored <= judgedAgainst) return {
		target: null,
		stored,
		judgedAgainst,
		state: STORED_TARGET.NOT_ABOVE_START
	};
	return {
		target: stored,
		stored,
		judgedAgainst,
		state: STORED_TARGET.USABLE
	};
}
/** The stored target balance when a reader may use it, null otherwise. */
function usableStoredTarget(meta) {
	return storedTargetStatus(meta).target;
}
//#endregion
//#region src/domain/simulationAccounts.js
/** The nature of the money in an account. Never inferred as a silent default. */
var ACCOUNT_NATURES = {
	LIVE: "live",
	SIMULATION: "simulation",
	UNDETERMINED: "undetermined"
};
/**
* The explicit, CAM-set override. Stored on trading_accounts.simulation_mode.
*
* AUTO ('' / null) is not a third opinion, it is the absence of one: the ladder
* below runs. The two named values end the ladder immediately, which is what
* makes every heuristic here correctable.
*/
var SIMULATION_MODES = {
	AUTO: "",
	SIMULATION: "simulation",
	LIVE: "live"
};
/**
* account_type value for a simulation account.
*
* Declared HERE rather than imported from reconcile.js so this module stays a
* leaf: reconcile.js imports the classifier, and a cycle between the two would
* put ACCOUNT_TYPES in its temporal dead zone on whichever module happened to
* load first.
*/
var SIMULATION_ACCOUNT_TYPE = "Simulation";
/**
* account_type values that assert the account holds real money.
*
* Mirrors reconcile.js ACCOUNT_TYPES minus Simulation, Unassigned and
* Inactive / Ignore — the three that assert nothing about the money. The
* duplication is deliberate (see above) and guarded: simulationAccounts.test.js
* asserts this list equals reconcile's ACCOUNT_TYPES exactly, so adding a type
* there without deciding about it here fails the suite.
*
* 'Cash' is the legacy pre-split value and must stay for the same reason it
* stays in reconcile.js:16 — account_type is free text with no CHECK constraint
* and rows written before the IRA/Straight split still store it.
*/
var MONEY_ACCOUNT_TYPES = [
	"Evaluation - Bullet Bot",
	"Evaluation - Standard",
	"Funded",
	"Cash - IRA",
	"Cash - Straight",
	"Cash"
];
/**
* NinjaTrader's own simulation account naming: Sim101, Sim102, ...
*
* Anchored and digits-only on purpose. All 11 simulation accounts on the real
* book are exactly `Sim101`. The loose `startsWith('sim')` test this replaces
* also matched `Simmons - Main` and `Simon 01`, and because the old code deleted
* what it matched, a real account named that way lost every close it ever had
* with no flag, no warning and no count.
*/
var PLATFORM_SIM_NAME = /^sim[\s_-]*\d+$/i;
/**
* Names that look like a simulator but are not the platform's naming.
*
* These resolve to UNDETERMINED, never to SIMULATION. A simulation a client
* renamed `Practice` and a live account somebody labelled `Practice` produce the
* same string, and guessing either way is how money gets misreported.
*
* Note what is NOT here: `Simmons - Main` and `Simon 01`. The old
* `startsWith('sim')` filter matched and silently deleted both; they now fall
* through to LIVE, which is what they are. Making them undetermined would trade
* one wrong answer for another.
*
* 0 of the 62 distinct account names in the 11 real exports and 0 of the 764
* rows in the redacted book match this, so nothing on today's data moves because
* of it.
*/
var AMBIGUOUS_NAME = /^sim$|^sim[^a-z0-9]|\b(?:demo|practice|simulator|simulated|simulation)\b/i;
/**
* The platform's naming with something ELSE attached: `Sim101 - backup`,
* `Sim101a`, `Sim 1 copy`.
*
* These used to fall all the way through to LIVE, because PLATFORM_SIM_NAME is
* anchored at both ends and AMBIGUOUS_NAME's `^sim[^a-z0-9]` cannot fire on a
* name whose fourth character is a digit. So a duplicated or annotated Sim101 —
* the shape a desk produces the moment it runs two SIM sessions, or copies one
* to keep a record — was counted as real desk capital at NinjaTrader's stock
* $100,000, with no flag and nothing on any surface to say so.
*
* UNDETERMINED rather than SIMULATION: `Sim101 - backup` is almost certainly a
* simulator, but `Sim500 Funded` could genuinely be a live account somebody
* numbered that way, and the whole point of this module is that a guess about
* which bucket money belongs in gets reported instead of made.
*/
var PLATFORM_SIM_NAME_WITH_SUFFIX = /^sim[\s_-]*\d/i;
/**
* Characters that are invisible on every surface a human reads.
*
* `Sim101` and `Sim101` with a zero-width space glued to the end are the same
* account to anyone looking at the NinjaTrader grid or at this CRM, and the
* second one was being classified as real desk capital. Zero-width space,
* zero-width non-joiner and joiner, the
* word joiner and the BOM all survive String.trim(), which strips only
* whitespace, so they have to be removed explicitly before any name is matched.
* They are stripped for MATCHING only — every message still quotes the name as
* it was stored, so a CAM searching for it can still find it.
*/
var INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
function text(value) {
	return String(value ?? "").trim();
}
function lower$1(value) {
	return text(value).toLowerCase();
}
function matchable(value) {
	return text(value).replace(INVISIBLE, "").trim();
}
function nameSignal(accountName) {
	const name = text(accountName);
	const match = matchable(accountName);
	if (!match) return null;
	if (PLATFORM_SIM_NAME.test(match)) return {
		nature: ACCOUNT_NATURES.SIMULATION,
		reason: `the account is named ${name}, which is NinjaTrader's Sim<number> simulation naming`
	};
	if (AMBIGUOUS_NAME.test(match)) return {
		nature: ACCOUNT_NATURES.UNDETERMINED,
		reason: `the name ${name} reads like a simulator but is not NinjaTrader's Sim<number> naming, so it could equally be a real account`
	};
	if (PLATFORM_SIM_NAME_WITH_SUFFIX.test(match)) return {
		nature: ACCOUNT_NATURES.UNDETERMINED,
		reason: `the name ${name} starts with NinjaTrader's Sim<number> simulation naming but does not end there, so it could be a copy of a simulator or a real account numbered that way`
	};
	return null;
}
/**
* Resolve what kind of money an account holds.
*
* Ladder, strongest first. Every rung records WHY, because a reclassification
* nobody can check is worse than no reclassification: "treated as simulation
* because the account is named Sim101" is auditable, a silent bucket change is
* not.
*
* @param {object} meta      registry metadata (accountType, simulationMode, alias)
* @param {object} context   { accountName, isSimulated } — isSimulated is the
*                           platform's own flag, null/undefined when the
*                           collector did not report one (it does not yet).
* @returns {{nature: string, source: string, heuristic: boolean, reason: string,
*            conflict: null|{declared: string, observed: string}}}
*/
function classifyAccountNature(meta = {}, context = {}) {
	const accountName = context.accountName || meta?.accountName || "";
	const isSimulated = context.isSimulated;
	const mode = lower$1(meta?.simulationMode);
	if (mode === SIMULATION_MODES.LIVE) return decided(ACCOUNT_NATURES.LIVE, "registry", false, "the account record is set to live money, which overrides every automatic signal");
	if (mode === SIMULATION_MODES.SIMULATION) return decided(ACCOUNT_NATURES.SIMULATION, "registry", false, "the account record is set to simulation");
	const accountType = text(meta?.accountType);
	const declared = accountType === "Simulation" ? ACCOUNT_NATURES.SIMULATION : MONEY_ACCOUNT_TYPES.includes(accountType) ? ACCOUNT_NATURES.LIVE : null;
	const observed = isSimulated === true ? ACCOUNT_NATURES.SIMULATION : isSimulated === false ? ACCOUNT_NATURES.LIVE : null;
	const named = nameSignal(accountName);
	const namedDecisive = named && named.nature !== ACCOUNT_NATURES.UNDETERMINED ? named.nature : null;
	const votes = [
		declared ? {
			nature: declared,
			source: "accountType",
			heuristic: false,
			reason: `the account record says its type is ${accountType}`
		} : null,
		observed ? {
			nature: observed,
			source: "platform",
			heuristic: false,
			reason: isSimulated ? "the trading platform reported this account as a simulator account" : "the trading platform reported this account as a live account"
		} : null,
		!observed && namedDecisive ? {
			nature: namedDecisive,
			source: "name",
			heuristic: true,
			reason: named.reason
		} : null
	].filter(Boolean);
	if (!votes.length) {
		if (named) return decided(ACCOUNT_NATURES.UNDETERMINED, "name", true, named.reason);
		return decided(ACCOUNT_NATURES.LIVE, "default", false, "no simulation signal on the name, the account record or the platform");
	}
	if (new Set(votes.map((vote) => vote.nature)).size > 1) {
		const parts = votes.map((vote) => vote.reason);
		return {
			nature: ACCOUNT_NATURES.UNDETERMINED,
			source: "conflict",
			heuristic: false,
			reason: `signals disagree — ${parts.join("; ")}. Set the account's simulation setting to resolve it.`,
			conflict: {
				declared: declared || null,
				observed: observed || null,
				named: namedDecisive || null
			}
		};
	}
	const winner = votes[0];
	return {
		nature: winner.nature,
		source: winner.source,
		heuristic: votes.every((vote) => vote.heuristic),
		reason: winner.reason,
		conflict: null
	};
}
function decided(nature, source, heuristic, reason) {
	return {
		nature,
		source,
		heuristic,
		reason,
		conflict: null
	};
}
ACCOUNT_NATURES.SIMULATION, ACCOUNT_NATURES.UNDETERMINED, ACCOUNT_NATURES.LIVE;
function emptyTotals() {
	return {
		accounts: 0,
		balance: 0,
		dailyPnl: 0,
		weeklyPnl: 0
	};
}
function addSnapshot(totals, snapshot) {
	totals.accounts += 1;
	totals.balance += Number(snapshot?.accountBalance || 0);
	totals.dailyPnl += Number(snapshot?.grossRealizedPnl || 0);
	totals.weeklyPnl += Number(snapshot?.weeklyPnl || 0);
}
function emptySide() {
	return {
		accounts: {},
		snapshots: [],
		strategies: [],
		orders: [],
		executions: [],
		totals: emptyTotals()
	};
}
/**
* Split one close into live rows, simulated rows and undetermined rows.
*
* Separation by CONSTRUCTION, not by filtering at each consumer. Every existing
* surface reads `dailyImport.snapshots`; leaving simulated rows in there and
* asking twenty aggregators to remember to exclude them is the failure mode this
* whole feature exists to end — one forgotten reducer and $1,099,590 of play
* money lands in desk capital. So the live arrays keep exactly the rows they
* hold today, and everything else moves into its own container.
*
* @param {{accounts?: object, snapshots?: Array, strategies?: Array,
*          orders?: Array, executions?: Array,
*          platformFlags?: object}} close
* @returns {{live: object, simulation: object, natureByAccount: object}}
*/
function splitSimulationRows(close = {}) {
	const registry = close.accounts || {};
	const platformFlags = close.platformFlags || {};
	const metaByLower = {};
	for (const [name, meta] of Object.entries(registry)) metaByLower[lower$1(name)] = {
		name,
		meta
	};
	const natureByAccount = {};
	const classify = (accountName) => {
		const key = lower$1(accountName);
		if (natureByAccount[key]) return natureByAccount[key];
		const entry = metaByLower[key];
		const meta = entry?.meta || {};
		const flag = Object.prototype.hasOwnProperty.call(platformFlags, key) ? platformFlags[key] : void 0;
		const result = {
			accountName: entry?.name || accountName,
			alias: meta.alias || entry?.name || accountName,
			accountType: meta.accountType || "",
			...classifyAccountNature(meta, {
				accountName: entry?.name || accountName,
				isSimulated: flag
			})
		};
		natureByAccount[key] = result;
		return result;
	};
	for (const name of Object.keys(registry)) classify(name);
	const live = {
		snapshots: [],
		strategies: [],
		orders: [],
		executions: []
	};
	const simulation = emptySide();
	const undetermined = emptySide();
	const sideFor = (accountName) => {
		const nature = classify(accountName).nature;
		if (nature === ACCOUNT_NATURES.SIMULATION) return simulation;
		if (nature === ACCOUNT_NATURES.UNDETERMINED) return undetermined;
		return null;
	};
	for (const snapshot of close.snapshots || []) {
		const side = sideFor(snapshot?.accountName);
		if (!side) {
			live.snapshots.push(snapshot);
			continue;
		}
		side.snapshots.push(snapshot);
		addSnapshot(side.totals, snapshot);
	}
	for (const key of [
		"strategies",
		"orders",
		"executions"
	]) for (const row of close[key] || []) {
		const side = sideFor(row?.accountName);
		(side ? side[key] : live[key]).push(row);
	}
	for (const [key, entry] of Object.entries(natureByAccount)) {
		const meta = metaByLower[key]?.meta;
		if (!meta) continue;
		if (entry.nature === ACCOUNT_NATURES.SIMULATION) simulation.accounts[entry.accountName] = meta;
		else if (entry.nature === ACCOUNT_NATURES.UNDETERMINED) undetermined.accounts[entry.accountName] = meta;
	}
	const classifications = Object.values(natureByAccount).filter((entry) => entry.nature !== ACCOUNT_NATURES.LIVE).sort((a, b) => a.accountName.localeCompare(b.accountName));
	const accountsInClose = (close.snapshots || []).length;
	return {
		natureByAccount,
		live,
		simulation: {
			...simulation,
			undetermined,
			classifications,
			denominator: {
				accountsInClose,
				accountsOnRecord: Object.keys(registry).length
			},
			hasSimulation: undetermined.snapshots.length ? null : simulation.snapshots.length > 0
		}
	};
}
/**
* Everything that must be written to the database for one close: live rows plus
* simulated rows plus undetermined rows.
*
* The split is an APPLICATION-LAYER concern. account_snapshots stores one row
* per account per close regardless of nature, and the split is recomputed on
* load from the account's own record — so a CAM correcting a misclassification
* fixes every close at once instead of only the ones imported after the fix.
*/
function mergeSimulationRows(importResult = {}) {
	const sim = importResult.simulation || {};
	const und = sim.undetermined || {};
	const join = (key) => [
		...importResult[key] || [],
		...sim[key] || [],
		...und[key] || []
	];
	return {
		snapshots: join("snapshots"),
		strategies: join("strategies"),
		orders: join("orders"),
		executions: join("executions")
	};
}
//#endregion
//#region src/domain/reconcile.js
var ACCOUNT_TYPES = {
	UNASSIGNED: "Unassigned",
	EVALUATION_BULLET: "Evaluation - Bullet Bot",
	EVALUATION_STANDARD: "Evaluation - Standard",
	FUNDED: "Funded",
	CASH_IRA: "Cash - IRA",
	CASH_STRAIGHT: "Cash - Straight",
	CASH: "Cash",
	IGNORE: "Inactive / Ignore",
	SIMULATION: SIMULATION_ACCOUNT_TYPE,
	PENDING_CLASSIFICATION: "Pending classification"
};
var CASH_ACCOUNT_TYPES = [
	ACCOUNT_TYPES.CASH_IRA,
	ACCOUNT_TYPES.CASH_STRAIGHT,
	ACCOUNT_TYPES.CASH
];
function isCashType(accountType) {
	return CASH_ACCOUNT_TYPES.includes(accountType);
}
function isSimulationAccountType(accountType) {
	return String(accountType || "").trim() === ACCOUNT_TYPES.SIMULATION;
}
var ACCOUNT_STATUSES = {
	ACTIVE: "Active",
	INACTIVE: "Inactive",
	RESERVE: "Reserve",
	FAILED: "Failed",
	PAYOUT_HOLD: "Payout Hold"
};
var PAYOUT_STATES = {
	NOT_REQUESTED: "Not requested",
	REQUEST_PAYOUT: "Request payout",
	PAYOUT_REQUESTED: "Payout requested",
	PAYOUT_APPROVED: "Payout approved",
	CLEAR_TO_TRADE: "Clear to trade"
};
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function makeAccountAlias(accountName, connection = "") {
	const name = String(accountName || "");
	const label = String(connection || "Account").trim() || "Account";
	if (!name) return label;
	if (name.length <= 8) return `${label} - ${name}`;
	if (/\s/.test(name) && !/\d{5}/.test(name)) return `${label} - ${name}`;
	return `${label} - ${name.slice(-4)}`;
}
/**
* The type a never-before-seen account starts life with.
*
* Only a BRAND-NEW account can be seeded as Simulation, and only when the
* classifier already recognises it (name matches NinjaTrader's Sim<number>, or
* the platform said so). An account that already has a stored type keeps it —
* `existing.accountType` wins in createDefaultAccount — so this can never
* reclassify a row a CAM has touched, and the seeding is announced with a
* `New simulation account` flag rather than happening silently.
*/
function defaultAccountTypeFor(account, existing) {
	if (existing?.accountType) return existing.accountType;
	return classifyAccountNature({
		...existing,
		accountName: account.accountName
	}, {
		accountName: account.accountName,
		isSimulated: account.isSimulated
	}).nature === ACCOUNT_NATURES.SIMULATION ? ACCOUNT_TYPES.SIMULATION : ACCOUNT_TYPES.UNASSIGNED;
}
function createDefaultAccount(account, existing = {}) {
	return {
		accountName: account.accountName,
		alias: existing.alias || makeAccountAlias(account.accountName, account.connection),
		connection: account.connection || existing.connection || "",
		accountType: defaultAccountTypeFor(account, existing),
		simulationMode: existing.simulationMode || "",
		status: existing.status || ACCOUNT_STATUSES.ACTIVE,
		payoutState: existing.payoutState || PAYOUT_STATES.NOT_REQUESTED,
		startBalance: existing.startBalance ?? "",
		targetProfit: existing.targetProfit ?? "",
		maxDrawdownLimit: existing.maxDrawdownLimit ?? "",
		propFirmPlan: existing.propFirmPlan || "",
		riskLevel: existing.riskLevel || "",
		algoStack: existing.algoStack || "",
		dailyLossLimit: existing.dailyLossLimit || "",
		bulletBotPassType: existing.bulletBotPassType || "",
		bulletBotDirection: existing.bulletBotDirection || "",
		notes: existing.notes || "",
		dateAdded: existing.dateAdded || nowIso().slice(0, 10),
		dateFailed: existing.dateFailed || "",
		dateFunded: existing.dateFunded || "",
		dateLastPayout: existing.dateLastPayout || "",
		payoutCount: existing.payoutCount ?? 0
	};
}
/**
* Flag ids must be UUIDs.
*
* A flag raised here is written straight to operational_flags, whose primary key
* is a uuid, and the same id is what the CRM later sends back to resolve it. A
* composite key like `Strategy disabled-FTDFYL1001-za9s0gd` read fine as a React
* key but Postgres rejected it, so closing a freshly imported flag failed: the
* optimistic update hid it, the next load brought it back, and only after a
* reload — once the row carried a database-generated uuid — did closing stick.
*/
function newFlagId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const random = Math.floor(Math.random() * 16);
		return (char === "x" ? random : random & 3 | 8).toString(16);
	});
}
function makeFlag({ type, severity = "Warning", accountName = "", message }) {
	return {
		id: newFlagId(),
		type,
		severity,
		accountName,
		message,
		status: "Open"
	};
}
function groupStrategiesByAccount(strategies = []) {
	return strategies.reduce((map, strategy) => {
		if (!strategy.accountName) return map;
		if (!map[strategy.accountName]) map[strategy.accountName] = [];
		map[strategy.accountName].push(strategy);
		return map;
	}, {});
}
function shouldExpectStrategy(meta) {
	if (!meta) return false;
	if (meta.accountType === ACCOUNT_TYPES.IGNORE) return false;
	if (meta.accountType === ACCOUNT_TYPES.SIMULATION) return false;
	if ([
		ACCOUNT_STATUSES.INACTIVE,
		ACCOUNT_STATUSES.RESERVE,
		ACCOUNT_STATUSES.FAILED,
		ACCOUNT_STATUSES.PAYOUT_HOLD
	].includes(meta.status)) return false;
	return meta.accountType !== ACCOUNT_TYPES.UNASSIGNED;
}
function hasStrategyThatRan(strategies = []) {
	return strategies.some((strategy) => strategyRan(strategy));
}
function isMissing(value) {
	return value === void 0 || value === null;
}
function withoutDerivation(value) {
	return value === void 0 ? 0 : value;
}
/**
* What of a derivation is worth keeping on the snapshot — and what is not.
*
* deriveStrategyPnl returns twenty fields, and `reconcileDailyImport` needs all
* of them: `byStrategy` is what the join carries onto the roster rows, and
* `reconciles`/`positionAgrees`/`unpricedPairs`/`unknownInstruments`/
* `refusedBooks` are what decide `status` in the first place. NONE of that has
* to be STORED, and storing it is not free. This object is written verbatim into
* account_snapshots.derivation (jsonb, step 37) and read back by two things that
* select '*': supabaseStore.loadTable on every CRM state load, and
* server/export/clientExport.js, whose own header records the busiest CAM's
* default pull at 4.06 MB against a 4 MiB ceiling enforced as a 413. It is over
* that line already. account_snapshots is ~322 B a row of scalars; the full
* derivation measured 606 B a row mean on a real ten-folder export — the blob
* was about to be two thirds of the row it hangs off.
*
* So this is a projection, and it is drawn on one rule: keep what cannot be
* recovered from another stored column, drop what can.
*
*   status         Kept. Nothing else records the account-day's verdict, and
*                  algoContribution refuses to show a split without seeing
*                  'exact' here. It now also carries the two refusals —
*                  'refused' (a book that could not be priced) and
*                  'no-reported-gross' (no column to check the total against) —
*                  which is why the residual's REASONS below have to be kept
*                  whole: 'refused' says an account was declined, and only
*                  `residual.reasons` says whether that was a carried-in
*                  position, an instrument missing from the multiplier table, or
*                  an ordering the Position column contradicts — and those three
*                  have three different fixes (upload yesterday, add a
*                  multiplier, look at the grid's Position column).
*   reportedGross  Kept, and load-bearing: mapAccountSnapshot does NOT store
*                  `grossRealizedPnlReported`, so this is the only surviving
*                  copy of the raw 'Gross realized PnL' column, and it is the
*                  basis the display re-checks the derived rows add up to.
*   residual       Kept whole — the realized amount, the pair count and the
*                  reasons. This is money the fills paired and could not credit
*                  to any one strategy; nothing else stores it, and the point of
*                  the feature is that it is surfaced rather than folded away.
*   join           Kept, trimmed to `status`, `published`, `offRoster`,
*                  `offRosterRealized` and — only when it is non-empty —
*                  `ambiguousNames`. Off-roster money is derived money that
*                  belongs to a strategy on no row of this account's grid, so no
*                  strategy_snapshots row can carry it — exactly the money the
*                  old one-directional join deleted in silence.
*
* WHY `ambiguousNames` IS HERE AND NOT PER ROW. It is the one per-row verdict
* this blob could not otherwise answer. Step 37 originally shipped a
* `strategy_snapshots.derived_realized_join` column carrying ROW_JOIN per roster
* row; measured through mapStrategy on the real ten-folder export that was
* 37.1 B on EVERY strategy row, and four of its five values are recoverable from
* `derived_realized` plus `status`/`published` here (the table is in the ROW_JOIN
* comment in joinDerivedStrategies.js). Only 'ambiguous-name' was not: a row
* refused because its name matched several roster rows looks exactly like a row
* refused for any other reason. So the names are kept ONCE per account-day, and
* only on a day that had any — 0 of 40 account-days on that export, so 0 bytes
* there — instead of a string on all 1,033 strategy rows of the busiest CAM's
* pull. Same fact, same recoverable per-row answer, ~37 KiB less.
*
* Dropped, with where to find them instead: `byStrategy` (per row, in
* strategy_snapshots.derived_realized — storing it here is the same figures a
* second time); `join.unmatchedRoster` (the published rows whose
* `derived_realized` is null), `join.matchedRows` (the published rows whose
* `derived_realized` is not), `join.rosterRows` (count the account's
* strategy_snapshots rows), `join.derivedRows` (`matchedRows` + `offRoster` on a
* published day); `attributedTotal`, `derivedTotal`, `difference`,
* `joinedTotal`, `balanced` (arithmetic over figures already stored); `pairs`,
* `unpricedPairs`, `detachedPairs`, `openContracts`, `carriedInContracts`,
* `unknownInstruments`, `refusedBooks`, `carryInBasis`, `orderingBasis`,
* `positionAgrees`, `reconciles` (inputs to `status`, which is stored — and
* re-derivable from the executions, which are stored too).
*
* `refusedBooks` is the one of those worth pausing on, because it names an
* instrument and looks like information nothing else holds. It is not: the
* instrument is on every execution row of the same close, and which KIND of
* refusal it was is in `residual.reasons`, which is kept. Storing the array
* would be a third copy of a fact already in two places.
*
* AND AN ACCOUNT THAT DID NOT TRADE STORES NOTHING AT ALL. A 'no-trades'
* derivation is sixteen fields of zero and one string; it makes exactly the
* claim a NULL makes, at 560 bytes a row instead of none. Nineteen of the forty
* account-days on that export were in this state. `algoContribution` reads an
* absent derivation and a 'no-trades' one identically — neither can produce a
* derived day — so this is invisible to the display and worth ~10.6 KB per forty
* snapshots stored.
*
* NOT A WEAKENING OF THE RECONCILIATION. Everything above is still computed, and
* every refusal still fires on the full result: the join sees `byStrategy`, the
* per-row columns are written from it, and `status` is decided before this
* function is reached. This only decides what survives the trip to the database.
*/
function storableDerivation(derivation) {
	if (!derivation) return null;
	if (derivation.status === "no-trades") return null;
	const join = derivation.join || null;
	return {
		status: derivation.status,
		reportedGross: derivation.reportedGross ?? null,
		residual: derivation.residual || {
			realized: 0,
			pairs: 0,
			reasons: {}
		},
		...join ? { join: {
			status: join.status,
			published: Boolean(join.published),
			offRoster: join.offRoster || [],
			offRosterRealized: join.offRosterRealized || 0,
			...join.ambiguousNames?.length ? { ambiguousNames: [...join.ambiguousNames] } : {}
		} } : {}
	};
}
function createSnapshot(account, strategies, derived = {}, derivation = null) {
	const reportedTrailing = account.trailingMaxDrawdown;
	const reportedWeekly = account.weeklyPnl;
	const useDerivedTrailing = isMissing(reportedTrailing) && derived.trailing != null;
	const useDerivedWeekly = isMissing(reportedWeekly) && derived.weekly != null;
	return {
		accountName: account.accountName,
		connection: account.connection || "",
		grossRealizedPnl: account.grossRealizedPnl === void 0 ? 0 : account.grossRealizedPnl,
		pnlSource: account.pnlSource || null,
		trailingMaxDrawdown: useDerivedTrailing ? derived.trailing.value : withoutDerivation(reportedTrailing),
		trailingSource: useDerivedTrailing ? "derived" : isMissing(reportedTrailing) ? null : "reported",
		trailingPeak: useDerivedTrailing ? derived.trailing.peak : null,
		trailingHasGaps: useDerivedTrailing ? derived.trailing.hasGaps : false,
		accountBalance: account.accountBalance === void 0 ? 0 : account.accountBalance,
		weeklyPnl: useDerivedWeekly ? derived.weekly.value : withoutDerivation(reportedWeekly),
		weeklyPnlSource: useDerivedWeekly ? "derived" : isMissing(reportedWeekly) ? null : "reported",
		unrealizedPnl: account.unrealizedPnl === void 0 ? 0 : account.unrealizedPnl,
		grossRealizedPnlReported: account.grossRealizedPnlReported ?? null,
		derivation: storableDerivation(derivation),
		strategies
	};
}
function reconcileDailyImport({ clientId, date, registry = {}, parsed, history = [], priorImports = [], fillsLoaded = true }) {
	const accountsByName = {};
	const snapshots = [];
	const flags = [];
	const registryByLower = Object.fromEntries(Object.entries(registry || {}).map(([k, v]) => [k.toLowerCase(), v]));
	const sourceAccounts = parsed.accounts || [];
	const reportedStrategies = parsed.strategies || [];
	const orders = scopeOrdersToDay(parsed.orders || [], date);
	const orderStrategyById = Object.fromEntries(orders.map((order) => [order.id, order.strategyName || ""]));
	const executions = scopeExecutionsToDay(parsed.executions || [], date).map((execution) => ({
		...execution,
		strategyName: orderStrategyById[execution.orderId] || ""
	}));
	const platformFlags = Object.fromEntries(sourceAccounts.filter((account) => typeof account.isSimulated === "boolean").map((account) => [String(account.accountName || "").toLowerCase(), account.isSimulated]));
	const derivationByAccount = deriveStrategyPnlByAccount({
		executions,
		orders,
		accounts: sourceAccounts,
		carryInByAccount: carryForwardLots({
			dailyImports: (priorImports || []).map((entry) => ({
				date: entry?.date,
				...mergeSimulationRows(entry)
			})),
			date
		}).byAccount
	});
	const rosterByAccount = /* @__PURE__ */ new Map();
	reportedStrategies.forEach((strategy, index) => {
		const key = String(strategy.accountName || "").trim();
		if (!rosterByAccount.has(key)) rosterByAccount.set(key, []);
		rosterByAccount.get(key).push({
			strategy,
			index
		});
	});
	const strategies = new Array(reportedStrategies.length);
	const joinedDerivationByAccount = /* @__PURE__ */ new Map();
	for (const key of /* @__PURE__ */ new Set([...rosterByAccount.keys(), ...derivationByAccount.keys()])) {
		const derivation = derivationByAccount.get(key) || null;
		const roster = rosterByAccount.get(key) || [];
		const joined = joinDerivedStrategies({
			strategies: roster.map((entry) => entry.strategy),
			derivation
		});
		joined.strategies.forEach((strategy, position) => {
			strategies[roster[position].index] = strategy;
		});
		if (derivation) joinedDerivationByAccount.set(key, {
			...derivation,
			join: joined.join
		});
	}
	const ranStrategies = withStrategyRan(strategies, executions, { evidenceComplete: fillsLoaded });
	const strategiesByAccount = groupStrategiesByAccount(ranStrategies);
	const ranIsKnown = (strategy) => ranAnswerIsKnown(strategy, { closeHasFills: fillsLoaded });
	const nothingRanIsKnown = (list) => fillsLoaded || list.length > 0 && list.every(ranIsKnown);
	const seen = /* @__PURE__ */ new Set();
	for (const account of sourceAccounts) {
		const existing = registry[account.accountName] || registryByLower[account.accountName.toLowerCase()];
		const meta = createDefaultAccount(account, existing);
		const strategies = strategiesByAccount[account.accountName] || [];
		const nature = classifyAccountNature({
			...existing || {},
			accountName: account.accountName
		}, {
			accountName: account.accountName,
			isSimulated: account.isSimulated
		});
		const isRealMoney = nature.nature === ACCOUNT_NATURES.LIVE;
		accountsByName[account.accountName] = meta;
		const todayClose = {
			date,
			snapshots: [{
				accountName: account.accountName,
				accountBalance: account.accountBalance,
				grossRealizedPnl: account.grossRealizedPnl
			}]
		};
		const closes = [...history, todayClose];
		const derived = {
			trailing: !isRealMoney || isCashType(meta.accountType) || account.trailingMaxDrawdown !== void 0 && account.trailingMaxDrawdown !== null ? null : deriveTrailingDrawdown(closes, account.accountName, date, { startBalance: meta.startBalance }),
			weekly: account.weeklyPnl === void 0 || account.weeklyPnl === null ? deriveWeeklyPnl(closes, account.accountName, date) : null
		};
		snapshots.push(createSnapshot(account, strategies, derived, joinedDerivationByAccount.get(String(account.accountName || "").trim())));
		seen.add(account.accountName.toLowerCase());
		if (nature.nature === ACCOUNT_NATURES.UNDETERMINED) flags.push(makeFlag({
			type: "Account nature undetermined",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} is counted as neither real nor simulated because ${nature.reason}`
		}));
		else if (nature.nature === ACCOUNT_NATURES.SIMULATION && nature.heuristic) flags.push(makeFlag({
			type: "New simulation account",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} is being reported as simulated because ${nature.reason}. Its balance and P&L are kept out of every real total. Confirm it on the account record, or mark it as live money if that is wrong.`
		}));
		else if (!existing) flags.push(makeFlag({
			type: "New account",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} is new and needs manual classification.`
		}));
		if (isRealMoney && meta.accountType === ACCOUNT_TYPES.UNASSIGNED && meta.status !== ACCOUNT_STATUSES.RESERVE) flags.push(makeFlag({
			type: "Unassigned account",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} needs an account type before close.`
		}));
		if (isRealMoney && shouldExpectStrategy(meta) && !hasStrategyThatRan(strategies) && nothingRanIsKnown(strategies)) flags.push(makeFlag({
			type: "Expected strategy missing",
			severity: "Critical",
			accountName: account.accountName,
			message: `${meta.alias} is active but no strategy ran in this close.`
		}));
		const ddLimit = !isRealMoney || isCashType(meta.accountType) ? NaN : Number(meta.maxDrawdownLimit);
		const snapshot = snapshots[snapshots.length - 1];
		const rawDD = Number(snapshot.trailingMaxDrawdown || 0);
		const limits = drawdownThresholds(snapshot.trailingSource);
		const derivedNote = snapshot.trailingSource === "derived" ? " (estimated from stored closes - confirm with the prop firm)" : "";
		if (Number.isFinite(ddLimit) && ddLimit > 0) {
			const currentDD = Math.abs(rawDD);
			if (currentDD > 0) {
				const remaining = ddLimit - currentDD;
				if (remaining <= 0) flags.push(makeFlag({
					type: "Drawdown breached",
					severity: "Critical",
					accountName: account.accountName,
					message: `${meta.alias} has exceeded its $${ddLimit.toLocaleString()} max drawdown limit. Account may be terminated.${derivedNote}`
				}));
				else if (remaining <= limits.critical) flags.push(makeFlag({
					type: "Drawdown near limit",
					severity: "Critical",
					accountName: account.accountName,
					message: `${meta.alias} is $${Math.round(remaining)} from its $${ddLimit.toLocaleString()} max drawdown limit. Immediate action required.${derivedNote}`
				}));
				else if (remaining <= limits.warning) flags.push(makeFlag({
					type: "Drawdown approaching limit",
					severity: "Warning",
					accountName: account.accountName,
					message: `${meta.alias} has $${Math.round(remaining)} remaining before its $${ddLimit.toLocaleString()} max drawdown limit.${derivedNote}`
				}));
			}
		} else if (isRealMoney && rawDD !== 0 && !isCashType(meta.accountType)) {
			if (rawDD <= 0) flags.push(makeFlag({
				type: "Drawdown breached",
				severity: "Critical",
				accountName: account.accountName,
				message: `${meta.alias} trailing drawdown buffer is $${rawDD.toLocaleString()} - account limit reached or exceeded. Verify with prop firm immediately.`
			}));
			else if (rawDD <= limits.critical) flags.push(makeFlag({
				type: "Drawdown near limit",
				severity: "Critical",
				accountName: account.accountName,
				message: `${meta.alias} has only $${Math.round(rawDD)} of trailing drawdown buffer remaining. Immediate action required.`
			}));
			else if (rawDD <= limits.warning) flags.push(makeFlag({
				type: "Drawdown approaching limit",
				severity: "Warning",
				accountName: account.accountName,
				message: `${meta.alias} has $${Math.round(rawDD)} of trailing drawdown buffer remaining.`
			}));
		}
		const targetProfit = isRealMoney ? usableStoredTarget(meta) ?? NaN : NaN;
		if (meta.accountType === ACCOUNT_TYPES.FUNDED && Number.isFinite(targetProfit) && targetProfit > 0 && Number(account.accountBalance) >= targetProfit && meta.payoutState === PAYOUT_STATES.NOT_REQUESTED) flags.push(makeFlag({
			type: "Payout eligible",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} reached its target profit. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Request payout.`
		}));
		if ([ACCOUNT_TYPES.EVALUATION_BULLET, ACCOUNT_TYPES.EVALUATION_STANDARD].includes(meta.accountType) && meta.status === ACCOUNT_STATUSES.ACTIVE && Number.isFinite(targetProfit) && targetProfit > 0 && Number(account.accountBalance) >= targetProfit) flags.push(makeFlag({
			type: "Evaluation target reached",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} reached its evaluation target. Balance $${Number(account.accountBalance).toLocaleString()} ≥ target $${targetProfit.toLocaleString()}. Deactivate and confirm consistency with the prop firm to activate.`
		}));
		if (meta.status === ACCOUNT_STATUSES.PAYOUT_HOLD && hasStrategyThatRan(strategies)) flags.push(makeFlag({
			type: "Payout hold violation",
			severity: "Critical",
			accountName: account.accountName,
			message: `${meta.alias} is in payout hold but ran a strategy.`
		}));
		if ([
			ACCOUNT_STATUSES.INACTIVE,
			ACCOUNT_STATUSES.RESERVE,
			ACCOUNT_STATUSES.FAILED
		].includes(meta.status) && hasStrategyThatRan(strategies)) flags.push(makeFlag({
			type: "Unexpected strategy active",
			severity: "Critical",
			accountName: account.accountName,
			message: `${meta.alias} is ${meta.status} but ran a strategy.`
		}));
		for (const strategy of strategies) if (!strategyRan(strategy) && ranIsKnown(strategy)) flags.push(makeFlag({
			type: "Strategy disabled",
			severity: "Warning",
			accountName: account.accountName,
			message: `${meta.alias} has ${strategy.strategyName || "a strategy"} disabled.`
		}));
	}
	for (const [accountName, meta] of Object.entries(registry || {})) {
		if (seen.has(accountName.toLowerCase())) continue;
		accountsByName[accountName] = meta;
		if (!(classifyAccountNature(meta, { accountName }).nature === ACCOUNT_NATURES.SIMULATION) && meta.accountType !== ACCOUNT_TYPES.IGNORE && meta.status !== ACCOUNT_STATUSES.INACTIVE) flags.push(makeFlag({
			type: "Missing account",
			severity: "Warning",
			accountName,
			message: `${meta.alias || accountName} existed before but did not appear in this close.`
		}));
	}
	const split = splitSimulationRows({
		accounts: accountsByName,
		snapshots,
		strategies: ranStrategies,
		orders,
		executions,
		platformFlags
	});
	return {
		id: `${clientId}-${date}-${Date.now()}`,
		clientId,
		date,
		importedAt: nowIso(),
		status: flags.some((flag) => flag.severity === "Critical" || flag.severity === "Warning") ? "Needs review" : "Ready to close",
		accounts: accountsByName,
		snapshots: split.live.snapshots,
		strategies: split.live.strategies,
		orders: split.live.orders,
		executions: split.live.executions,
		simulation: split.simulation,
		flags,
		pnlSourceSummary: summarizePnlSources(split.live.snapshots)
	};
}
//#endregion
//#region src/domain/operationsSegments.js
var SEGMENTS = {
	EVAL_STANDARD: "Evaluations - standard",
	EVAL_BULLET: "Evaluations - Bullet Bot",
	FUNDED: "Funded",
	CASH: "Cash",
	UNCLASSIFIED: "Unclassified",
	IGNORED: "Ignored",
	ORPHAN: "No account on record",
	SIMULATION: "Simulated (not real money)",
	UNDETERMINED: "Nature undetermined"
};
/**
* Ignored and orphan snapshots are counted, not silently dropped.
*
* Excluding them without saying so replaces one wrong total with another and
* hides the data problem. An orphan snapshot means an account was deleted or
* renamed while its closes stayed behind, which is worth seeing.
*
* SIMULATION and UNDETERMINED are here for a different reason: they are counted
* and shown, but they are not the desk's money. The 11 simulation accounts in
* the real exports hold $1,099,590 between them — 4.7% of the 427-account,
* $23,604,729.21 desk balance — and letting that into the headline would be the
* exact defect this feature exists to prevent. Anything added to SEGMENTS that
* is not real desk capital MUST be added here in the same commit.
*/
var EXCLUDED_FROM_TOTAL = /* @__PURE__ */ new Set([
	SEGMENTS.IGNORED,
	SEGMENTS.ORPHAN,
	SEGMENTS.SIMULATION,
	SEGMENTS.UNDETERMINED
]);
function segmentFor(meta) {
	if (!meta) return SEGMENTS.ORPHAN;
	const type = String(meta.accountType || "").trim();
	if (type === ACCOUNT_TYPES.SIMULATION) return SEGMENTS.SIMULATION;
	if (!type || type === ACCOUNT_TYPES.UNASSIGNED) return SEGMENTS.UNCLASSIFIED;
	if (type === ACCOUNT_TYPES.IGNORE) return SEGMENTS.IGNORED;
	if (isCashType(type)) return SEGMENTS.CASH;
	if (type === ACCOUNT_TYPES.EVALUATION_BULLET) return SEGMENTS.EVAL_BULLET;
	if (type === ACCOUNT_TYPES.EVALUATION_STANDARD) return SEGMENTS.EVAL_STANDARD;
	if (type === ACCOUNT_TYPES.FUNDED) return SEGMENTS.FUNDED;
	return type;
}
/**
* Segment an account by what its money IS before segmenting it by what it is
* FOR.
*
* The second line of defence. `reconcile.js` already routes simulated rows into
* their own container, so nothing simulated should ever reach a segment total —
* but an account whose stored type is still 'Unassigned' while its name is
* Sim101 would land in Unclassified, which IS counted in the desk total
* (51 accounts / $3,010,573.30 on the real book). Eleven Sim101s would have
* added $1,099,590 to it. Take the account name wherever it is available.
*/
function segmentForAccount(meta, accountName = "") {
	const name = accountName || meta?.accountName || "";
	const nature = classifyAccountNature(meta || {}, { accountName: name }).nature;
	if (nature === ACCOUNT_NATURES.SIMULATION) return SEGMENTS.SIMULATION;
	if (nature === ACCOUNT_NATURES.UNDETERMINED) return SEGMENTS.UNDETERMINED;
	if (!meta) return SEGMENTS.ORPHAN;
	return segmentFor(meta);
}
function emptyRow(segment, { withAccountNames = false } = {}) {
	const row = {
		segment,
		accounts: 0,
		clients: 0,
		dailyPnl: 0,
		weeklyPnl: 0,
		balance: 0,
		countedInTotal: !EXCLUDED_FROM_TOTAL.has(segment)
	};
	if (withAccountNames) row.accountNames = [];
	return row;
}
/**
* Per-segment totals for one close, or for many.
*
* `imports` is the same shape latestImports produces: one entry per client,
* holding the client and the daily import being read.
*
* TWO INPUT SHAPES, ONE ANSWER. `summaryRowsFor` is how a close that is NOT
* loaded row by row still reports: it returns the per-segment rows stored for
* that close (see closeSummary.js), which this function's own earlier run
* produced at ingest, and they are added to the same accumulator as a walked
* close. So a login that holds summaries for 2,500 closes and full snapshots
* for the 206 latest ones produces one totals object, by one addition, with no
* second segmentation anywhere. A close the callback declines (absent, or stale
* against the current account classification) falls through to its snapshots,
* and when it has none it is reported by `closesWithoutData` rather than
* counted as a zero.
*/
function buildSegmentTotals(imports = [], { withAccountNames = false, summaryRowsFor = null } = {}) {
	const rows = /* @__PURE__ */ new Map();
	const clientsPerSegment = /* @__PURE__ */ new Map();
	const add = (segment) => {
		if (!rows.has(segment)) rows.set(segment, emptyRow(segment, { withAccountNames }));
		if (!clientsPerSegment.has(segment)) clientsPerSegment.set(segment, /* @__PURE__ */ new Set());
		return rows.get(segment);
	};
	let closesFromSummary = 0;
	let closesWalked = 0;
	let closesWithoutData = 0;
	for (const entry of imports) {
		const registry = entry?.client?.accountRegistry || {};
		const clientId = entry?.client?.id ?? entry?.client?.name ?? "";
		const sim = entry?.dailyImport?.simulation;
		const summaryRows = summaryRowsFor ? summaryRowsFor(entry?.dailyImport, entry?.client) : null;
		if (summaryRows && summaryRows.length) {
			closesFromSummary += 1;
			for (const stored of summaryRows) {
				if (!Number(stored.accounts || 0)) continue;
				const row = add(stored.segment);
				clientsPerSegment.get(stored.segment).add(clientId);
				row.accounts += Number(stored.accounts || 0);
				row.dailyPnl += Number(stored.dailyPnl || 0);
				row.weeklyPnl += Number(stored.weeklyPnl || 0);
				row.balance += Number(stored.balance || 0);
				if (withAccountNames) row.accountNames.push(...stored.accountNames || []);
			}
			continue;
		}
		const snapshotRows = [
			...entry?.dailyImport?.snapshots || [],
			...sim?.snapshots || [],
			...sim?.undetermined?.snapshots || []
		];
		if (!snapshotRows.length) {
			closesWithoutData += 1;
			continue;
		}
		closesWalked += 1;
		for (const snapshot of snapshotRows) {
			const segment = segmentForAccount(registry[snapshot.accountName], snapshot.accountName);
			const row = add(segment);
			clientsPerSegment.get(segment).add(clientId);
			row.accounts += 1;
			row.dailyPnl += Number(snapshot.grossRealizedPnl || 0);
			row.weeklyPnl += Number(snapshot.weeklyPnl || 0);
			row.balance += Number(snapshot.accountBalance || 0);
			if (withAccountNames) row.accountNames.push(snapshot.accountName || "");
		}
	}
	for (const [segment, ids] of clientsPerSegment) rows.get(segment).clients = ids.size;
	const segments = [...rows.values()].sort((a, b) => a.dailyPnl - b.dailyPnl);
	return {
		segments,
		clientIdsBySegment: clientsPerSegment,
		excluded: segments.filter((row) => !row.countedInTotal),
		simulated: rows.get(SEGMENTS.SIMULATION) || emptyRow(SEGMENTS.SIMULATION),
		undetermined: rows.get(SEGMENTS.UNDETERMINED) || emptyRow(SEGMENTS.UNDETERMINED),
		accountsSeen: segments.reduce((sum, row) => sum + row.accounts, 0),
		provenance: {
			fromSummary: closesFromSummary,
			walked: closesWalked,
			withoutData: closesWithoutData
		}
	};
}
//#endregion
//#region src/domain/closeSummary.js
/**
* The row that says "this close was summarised and it held no account rows".
*
* A close with no account rows is real: 8 of the 485 on the book are in that
* state, one of them holding 15 orders against 0 accounts — the client's export
* carried the fills and not the grid. Such a close produces no segment row, and
* without this marker the table could not tell it apart from a close nobody has
* summarised yet. One of those contributes nothing and is complete; the other
* contributes nothing and is a hole, and a manager's basis line that called the
* first a hole would be wrong 8 times on every screen.
*
* Deliberately NOT a member of SEGMENTS. It must never reach `segmentFor`,
* `businessForSegment` or a roll-up — an unrecognised segment name lands in
* `propOther` by design, and this one carries no money to land there with. It
* is skipped on the way back in: a summary row with no accounts is a marker,
* never a figure.
*/
var EMPTY_CLOSE_SEGMENT = "(no account rows)";
/**
* The summary rows for one close, in the shape the table stores.
*
* `dailyImport` is a close as the app holds it — live snapshots on `snapshots`,
* the simulated and undetermined ones under `simulation` — because that is what
* `buildSegmentTotals` reads and what reconcile produces at ingest.
*/
function buildCloseSummaryRows({ accountRegistry = {}, dailyImport = null } = {}) {
	if (!dailyImport) return [];
	const totals = buildSegmentTotals([{
		client: {
			id: dailyImport.clientId || "",
			accountRegistry
		},
		dailyImport
	}], { withAccountNames: true });
	if (!totals.segments.length) return [{
		segment: EMPTY_CLOSE_SEGMENT,
		accounts: 0,
		dailyPnl: 0,
		weeklyPnl: 0,
		balance: 0,
		countedInTotal: false,
		accountNames: []
	}];
	return totals.segments.map((row) => ({
		segment: row.segment,
		accounts: row.accounts,
		dailyPnl: round2(row.dailyPnl),
		weeklyPnl: round2(row.weeklyPnl),
		balance: round2(row.balance),
		countedInTotal: row.countedInTotal,
		accountNames: row.accountNames || []
	}));
}
function round2(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}
/** The stored row, read back. */
function closeSummaryFromRow(row = {}) {
	return {
		dailyImportId: row.daily_import_id || "",
		clientUuid: row.client_id || "",
		date: String(row.trading_date || "").slice(0, 10),
		segment: row.segment || "",
		accounts: Number(row.accounts || 0),
		dailyPnl: Number(row.daily_pnl || 0),
		weeklyPnl: Number(row.weekly_pnl || 0),
		balance: Number(row.balance || 0),
		countedInTotal: row.counted_in_total !== false,
		accountNames: Array.isArray(row.account_names) ? row.account_names : []
	};
}
/**
* Attaches the app-level client id each row belongs to.
*
* The stored row carries the client UUID, and the registry is held against the
* app id (`legacy_key` where there is one). Done once here rather than inside
* the staleness loop, which would otherwise do the lookup per account name.
*/
function attachClientIds(rows = [], clientIdByUuid = {}) {
	return (rows || []).map((row) => ({
		...row,
		clientIdForRegistry: clientIdByUuid[row.clientUuid] || row.clientUuid
	}));
}
//#endregion
//#region src/domain/subscriptionPrice.js
var SUBSCRIPTION_PRICES = [
	"$500",
	"$250",
	"Free",
	"Undetermined"
];
var DEFAULT_SUBSCRIPTION_PRICE = "Undetermined";
function normalizeSubscriptionPrice(value) {
	return SUBSCRIPTION_PRICES.includes(value) ? value : DEFAULT_SUBSCRIPTION_PRICE;
}
//#endregion
//#region src/domain/clientTags.js
var CLIENT_TAGS = Object.freeze({
	AT_RISK: "At risk",
	VIP: "VIP",
	REFUND_SAVE: "Refund save"
});
var CLIENT_TAG_LIST = Object.freeze([
	CLIENT_TAGS.AT_RISK,
	CLIENT_TAGS.VIP,
	CLIENT_TAGS.REFUND_SAVE
]);
Object.freeze({
	[CLIENT_TAGS.AT_RISK]: "Losing engagement, performance or patience. Needs attention this week.",
	[CLIENT_TAGS.VIP]: "Treat first when time is short.",
	[CLIENT_TAGS.REFUND_SAVE]: "Kept by the prop firm with free CAM months instead of a refund. Not a conversion prospect."
});
/**
* Coerce anything stored or typed into the fixed set.
*
* Order is the declared order, not insertion order, so two clients with the
* same tags always render and compare identically. Unknown values are dropped
* rather than kept: a tag nothing can count is worse than no tag.
*/
function normalizeClientTags(value) {
	const wanted = new Set((Array.isArray(value) ? value : []).map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean));
	return CLIENT_TAG_LIST.filter((tag) => wanted.has(tag.toLowerCase()));
}
//#endregion
//#region src/domain/clientAccountFocus.js
var ACCOUNT_FOCUS = Object.freeze({
	CASH_STRAIGHT: "Cash straight",
	CASH_RETIREMENT: "Cash retirement",
	PROP: "Prop"
});
var ACCOUNT_FOCUS_LIST = Object.freeze([
	ACCOUNT_FOCUS.CASH_STRAIGHT,
	ACCOUNT_FOCUS.CASH_RETIREMENT,
	ACCOUNT_FOCUS.PROP
]);
Object.freeze({
	[ACCOUNT_FOCUS.CASH_STRAIGHT]: "Ordinary cash accounts.",
	[ACCOUNT_FOCUS.CASH_RETIREMENT]: "IRA or other retirement money. Different rules, same desk.",
	[ACCOUNT_FOCUS.PROP]: "Prop firm evaluations and funded accounts."
});
function normalizeAccountFocus(value) {
	const wanted = new Set((Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean));
	return ACCOUNT_FOCUS_LIST.filter((focus) => wanted.has(focus.toLowerCase()));
}
//#endregion
//#region src/domain/supabaseStore.js
function pickId(row) {
	return row.legacy_key || row.id;
}
function byId(rows) {
	return Object.fromEntries((rows || []).map((row) => [row.id, row]));
}
function byLegacy(rows) {
	return Object.fromEntries((rows || []).map((row) => [pickId(row), row]));
}
function accountMetaFromRow(row) {
	return {
		id: row.id,
		accountName: row.account_name,
		alias: row.alias || row.account_name,
		connection: row.connection || "",
		accountType: row.account_type || "Unassigned",
		status: row.status || "Active",
		payoutState: row.payout_state || "Not requested",
		targetProfit: row.target_profit ?? "",
		startBalance: row.start_balance ?? "",
		maxDrawdownLimit: row.max_drawdown_limit ?? "",
		propFirmPlan: row.prop_firm_plan || "",
		simulationMode: row.simulation_mode || "",
		riskLevel: row.risk_level || "",
		bulletBotPassType: row.bullet_bot_pass_type || "",
		bulletBotDirection: row.bullet_bot_direction || "",
		algoStack: row.algo_stack || "",
		dailyLossLimit: row.daily_loss_limit || "",
		notes: row.notes || "",
		dateAdded: row.date_added || "",
		dateFunded: row.date_funded || "",
		dateFailed: row.date_failed || "",
		dateLastPayout: row.date_last_payout || "",
		payoutCount: row.payout_count || 0,
		tradovateAccountId: row.tradovate_account_id || "",
		payoutHistory: []
	};
}
function strategyFromRow(row, accountById = {}) {
	const params = row.params_parsed && typeof row.params_parsed === "object" ? row.params_parsed : {};
	return {
		id: row.id,
		strategyName: row.strategy_name || "",
		accountName: accountById[row.trading_account_id]?.account_name || "",
		strategyFamily: row.strategy_family || "",
		strategyVersion: row.strategy_version || "",
		instrument: row.instrument || "",
		dataSeries: row.data_series || "",
		parametersRaw: row.parameters_raw || "",
		params,
		direction: row.direction || params.direction || "",
		enabled: Boolean(row.enabled),
		realized: numberOrNull$1(row.realized),
		unrealized: numberOrNull$1(row.unrealized),
		derivedRealized: numberOrNull$1(row.derived_realized),
		ran: typeof row.ran === "boolean" ? row.ran : null,
		ranBasis: row.ran_basis || ""
	};
}
function snapshotFromRow(row, strategiesBySnapshot, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.id,
		accountName: row.account_name,
		connection: row.connection || account?.connection || "",
		grossRealizedPnl: Number(row.gross_realized_pnl || 0),
		trailingMaxDrawdown: Number(row.trailing_max_drawdown || 0),
		accountBalance: Number(row.account_balance || 0),
		weeklyPnl: Number(row.weekly_pnl || 0),
		unrealizedPnl: Number(row.unrealized_pnl || 0),
		derivation: row.derivation || null,
		meta: account ? accountMetaFromRow(account) : {},
		strategies: strategiesBySnapshot[row.id] || []
	};
}
function executionFromRow(row, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.external_execution_id || row.id,
		accountName: account?.account_name || "",
		strategyName: row.strategy_name || "",
		instrument: row.instrument || "",
		action: row.action || "",
		quantity: Number(row.quantity || 0),
		price: Number(row.price || 0),
		time: row.time_text || "",
		entryExit: row.entry_exit || "",
		position: row.position || "",
		orderId: row.external_order_id || "",
		name: row.name || "",
		commission: Number(row.commission || 0),
		rate: Number(row.rate || 0),
		connection: row.connection || account?.connection || ""
	};
}
function orderFromRow(row, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.external_order_id || row.id,
		accountName: account?.account_name || "",
		strategyName: row.strategy_name || "",
		instrument: row.instrument || "",
		action: row.action || "",
		orderType: row.order_type || "",
		quantity: Number(row.quantity || 0),
		limit: Number(row.limit_price || 0),
		stop: Number(row.stop_price || 0),
		state: row.state || "",
		filled: Number(row.filled || 0),
		avgPrice: Number(row.avg_price || 0),
		remaining: Number(row.remaining || 0),
		name: row.name || "",
		time: row.time_text || ""
	};
}
function flagFromRow(row, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.id,
		type: row.type,
		severity: row.severity,
		accountName: account?.account_name || "",
		message: row.message,
		status: row.status || "Open",
		resolvedAt: row.resolved_at || ""
	};
}
function taskFromRow(row, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.legacy_key || row.id,
		text: row.text,
		priority: row.priority || "Normal",
		dueDate: row.due_date || "",
		accountName: account?.account_name || "",
		done: Boolean(row.done),
		doneAt: row.done_at || "",
		createdAt: row.created_at || ""
	};
}
function activityFromRow(row, accountById) {
	const account = accountById[row.trading_account_id] || null;
	return {
		id: row.legacy_key || row.id,
		type: row.type,
		text: row.text,
		accountName: account?.account_name || "",
		createdAt: row.created_at || "",
		logDate: row.log_date || "",
		logPnl: row.log_pnl != null ? Number(row.log_pnl) : null
	};
}
function priceCheckFromRow(row) {
	return {
		id: row.id,
		date: row.check_date || "",
		instrument: row.instrument || "",
		time: row.time_label || "",
		checkTime: row.time_label || "",
		price: row.price ?? "",
		connection: row.connection_status || "",
		connectionStatus: row.connection_status || "",
		algos: row.algo_status || "",
		algoStatus: row.algo_status || "",
		notes: row.notes || "",
		checked: Boolean(row.checked)
	};
}
function timeOffFromRow(row, camIdByUuid) {
	return {
		id: row.id,
		camProfileId: camIdByUuid[row.cam_profile_id] || row.cam_profile_id,
		camUuid: row.cam_profile_id,
		startDate: row.start_date || "",
		endDate: row.end_date || "",
		kind: row.kind || "Vacation",
		note: row.note || "",
		status: row.status || "Pending",
		requestedAt: row.requested_at || "",
		decidedAt: row.decided_at || "",
		decisionNote: row.decision_note || ""
	};
}
function coverageFromRow(row, camIdByUuid, clientIdByUuid) {
	return {
		id: row.id,
		clientId: clientIdByUuid[row.client_id] || row.client_id,
		coveringCamId: camIdByUuid[row.covering_cam_profile_id] || row.covering_cam_profile_id,
		absentCamId: camIdByUuid[row.absent_cam_profile_id] || row.absent_cam_profile_id || "",
		timeOffId: row.time_off_id || "",
		startDate: row.start_date || "",
		endDate: row.end_date || "",
		note: row.note || ""
	};
}
function propFirmFromRow(row) {
	const firmName = row.firm_name || "";
	return {
		id: row.id,
		name: firmName,
		firmName,
		connection: row.connection || "Tradovate",
		login: row.login || "",
		password: row.password_encrypted || "",
		sortOrder: row.sort_order ?? 0
	};
}
/**
* Table names the CRM state is built from, in the order buildCrmStateFromTables
* destructures them. A local snapshot must supply the same set.
*
* `close_summaries` is last because it arrived last (step 48) and the
* destructuring below is positional. A snapshot taken before it existed carries
* no such table and buildCrmStateFromTables derives the rows from the closes it
* has, so local mode reads the summary path rather than a path production no
* longer uses.
*/
var CRM_STATE_TABLES = [
	"cam_profiles",
	"clients",
	"client_assignments",
	"trading_accounts",
	"payout_events",
	"client_credentials",
	"client_prop_firms",
	"daily_imports",
	"account_snapshots",
	"strategy_snapshots",
	"orders",
	"executions",
	"operational_flags",
	"tasks",
	"activity_logs",
	"price_checks",
	"cam_time_off",
	"client_coverage",
	"close_summaries"
];
/**
* The latest close, in full, minus the two columns that make it heavy.
*
* `parameters_raw` and `params_parsed` are 2,231 B of a 2,731 B strategy row.
* They are fetched by the two panels that read them, for the day those panels
* are showing. `derivation` is the same argument on account_snapshots: a jsonb
* report per account-day that only the Stack Playbook's algo contribution
* reads, so it arrives when a close is opened.
*/
var LATEST_CLOSE_COLUMNS = {
	account_snapshots: "id, daily_import_id, trading_account_id, account_name, connection, gross_realized_pnl, trailing_max_drawdown, account_balance, weekly_pnl, unrealized_pnl",
	strategy_snapshots: "id, daily_import_id, account_snapshot_id, trading_account_id, strategy_name, strategy_family, strategy_version, instrument, data_series, direction, enabled, realized, unrealized, derived_realized, ran, ran_basis",
	executions: "id, daily_import_id, trading_account_id, external_execution_id, external_order_id, strategy_name, instrument, action, quantity, price, time_text, entry_exit, position, name, commission, rate, connection"
};
LATEST_CLOSE_COLUMNS.executions, `${LATEST_CLOSE_COLUMNS.account_snapshots}`, LATEST_CLOSE_COLUMNS.strategy_snapshots;
`${LATEST_CLOSE_COLUMNS.strategy_snapshots}`;
/**
* Builds the CRM state from raw table rows.
*
* Split out from the fetch so the same mapping serves a local snapshot. Running
* the app against a saved export otherwise means a second, parallel mapping
* that drifts from this one — and a local view that quietly disagrees with
* production is worse than no local view at all.
*/
function buildCrmStateFromTables(tables = {}, { preferredCamProfileId = null, loadedCloseIds = null, deriveMissingSummaries = true } = {}) {
	const [camRows, clientRows, assignmentRows, accountRows, payoutRows, credentialRows, propFirmRows, importRows, snapshotRows, strategyRows, orderRows, executionRows, flagRows, taskRows, activityRows, priceCheckRows, timeOffRows, coverageRows, summaryRows] = CRM_STATE_TABLES.map((table) => tables[table] || []);
	const loadedCloses = loadedCloseIds ? new Set(loadedCloseIds) : null;
	const visibleClientRows = (clientRows || []).filter((client) => !client.deleted_at && client.status !== "Inactive");
	const hiddenClientCount = (clientRows || []).length - visibleClientRows.length;
	const clientByUuid = byId(visibleClientRows);
	const accountByUuid = byId(accountRows);
	const accountByClient = {};
	const payoutsByAccount = {};
	const credentialsByClient = {};
	const propFirmsByClient = {};
	const importsByClient = {};
	const snapshotsByImport = {};
	const strategiesBySnapshot = {};
	const strategiesByImport = {};
	const ordersByImport = {};
	const executionsByImport = {};
	const flagsByImport = {};
	const tasksByClient = {};
	const activityByClient = {};
	const priceChecksByClient = {};
	for (const payout of payoutRows) {
		if (!payoutsByAccount[payout.trading_account_id]) payoutsByAccount[payout.trading_account_id] = [];
		payoutsByAccount[payout.trading_account_id].push({
			date: payout.payout_date,
			amount: Number(payout.amount || 0),
			state: payout.state || "",
			note: payout.note || ""
		});
	}
	for (const account of accountRows) {
		if (!accountByClient[account.client_id]) accountByClient[account.client_id] = [];
		accountByClient[account.client_id].push(account);
	}
	for (const credential of credentialRows) credentialsByClient[credential.client_id] = credential;
	for (const propFirm of propFirmRows) {
		if (!propFirmsByClient[propFirm.client_id]) propFirmsByClient[propFirm.client_id] = [];
		propFirmsByClient[propFirm.client_id].push(propFirmFromRow(propFirm));
	}
	for (const strategy of strategyRows) {
		const mapped = strategyFromRow(strategy, accountByUuid);
		if (strategy.account_snapshot_id) {
			if (!strategiesBySnapshot[strategy.account_snapshot_id]) strategiesBySnapshot[strategy.account_snapshot_id] = [];
			strategiesBySnapshot[strategy.account_snapshot_id].push(mapped);
		}
		if (!strategiesByImport[strategy.daily_import_id]) strategiesByImport[strategy.daily_import_id] = [];
		strategiesByImport[strategy.daily_import_id].push(mapped);
	}
	for (const snapshot of snapshotRows) {
		if (!snapshotsByImport[snapshot.daily_import_id]) snapshotsByImport[snapshot.daily_import_id] = [];
		snapshotsByImport[snapshot.daily_import_id].push(snapshotFromRow(snapshot, strategiesBySnapshot, accountByUuid));
	}
	for (const execution of executionRows) {
		if (!executionsByImport[execution.daily_import_id]) executionsByImport[execution.daily_import_id] = [];
		executionsByImport[execution.daily_import_id].push(executionFromRow(execution, accountByUuid));
	}
	for (const order of orderRows) {
		if (!ordersByImport[order.daily_import_id]) ordersByImport[order.daily_import_id] = [];
		ordersByImport[order.daily_import_id].push(orderFromRow(order, accountByUuid));
	}
	for (const flag of flagRows) {
		if (!flagsByImport[flag.daily_import_id]) flagsByImport[flag.daily_import_id] = [];
		flagsByImport[flag.daily_import_id].push(flagFromRow(flag, accountByUuid));
	}
	for (const dailyImport of importRows) {
		if (!importsByClient[dailyImport.client_id]) importsByClient[dailyImport.client_id] = [];
		importsByClient[dailyImport.client_id].push(dailyImport);
	}
	for (const task of taskRows) {
		if (!tasksByClient[task.client_id]) tasksByClient[task.client_id] = [];
		tasksByClient[task.client_id].push(taskFromRow(task, accountByUuid));
	}
	for (const activity of activityRows) {
		if (!activityByClient[activity.client_id]) activityByClient[activity.client_id] = [];
		activityByClient[activity.client_id].push(activityFromRow(activity, accountByUuid));
	}
	for (const check of priceCheckRows) {
		if (!priceChecksByClient[check.client_id]) priceChecksByClient[check.client_id] = [];
		priceChecksByClient[check.client_id].push(priceCheckFromRow(check));
	}
	const camProfiles = camRows.map((cam) => ({
		id: pickId(cam),
		name: cam.name,
		role: cam.role_title || "CAM",
		status: cam.status || "Active",
		live: Boolean(cam.live),
		monthlyGoal: Number(cam.monthly_goal || 0),
		canManageClients: Boolean(cam.can_manage_clients),
		reportConfig: cam.report_config && typeof cam.report_config === "object" ? cam.report_config : {},
		startDate: cam.start_date || "",
		email: cam.email || "",
		phone: cam.phone || "",
		timezone: cam.timezone || "",
		notes: cam.notes || "",
		clientOrder: Array.isArray(cam.client_order) ? cam.client_order : [],
		clientIds: assignmentRows.filter((assignment) => assignment.cam_profile_id === cam.id && clientByUuid[assignment.client_id]).map((assignment) => pickId(clientByUuid[assignment.client_id]))
	}));
	const preferredCam = byLegacy(camProfiles)[preferredCamProfileId] || camProfiles[0] || null;
	const clients = visibleClientRows.map((client) => {
		const accounts = accountByClient[client.id] || [];
		const accountRegistry = {};
		for (const account of accounts) {
			const meta = accountMetaFromRow(account);
			meta.payoutHistory = payoutsByAccount[account.id] || [];
			accountRegistry[account.account_name] = meta;
		}
		const credential = credentialsByClient[client.id] || {};
		const dailyImports = (importsByClient[client.id] || []).map((dailyImport) => {
			const split = splitSimulationRows({
				accounts: accountRegistry,
				snapshots: snapshotsByImport[dailyImport.id] || [],
				strategies: strategiesByImport[dailyImport.id] || [],
				orders: ordersByImport[dailyImport.id] || [],
				executions: executionsByImport[dailyImport.id] || []
			});
			return {
				id: dailyImport.legacy_key || dailyImport.id,
				uuid: dailyImport.id,
				clientId: pickId(client),
				date: dailyImport.trading_date,
				importedAt: dailyImport.imported_at,
				status: dailyImport.status,
				sourceSummary: dailyImport.source_summary || {},
				accounts: accountRegistry,
				snapshots: split.live.snapshots,
				strategies: split.live.strategies,
				orders: split.live.orders,
				executions: split.live.executions,
				simulation: split.simulation,
				flags: flagsByImport[dailyImport.id] || [],
				snapshotsLoaded: !loadedCloses || loadedCloses.has(dailyImport.id),
				detailLoaded: !loadedCloses,
				parametersLoaded: !loadedCloses
			};
		}).sort((a, b) => String(a.date).localeCompare(String(b.date)));
		return {
			id: pickId(client),
			uuid: client.id,
			name: client.name,
			reportConfig: client.report_config && typeof client.report_config === "object" ? client.report_config : {},
			status: client.status || "Active",
			pinned: Boolean(client.pinned),
			pinnedNote: client.pinned_note || "",
			notes: client.notes || "",
			churn: {
				reason: client.churn_reason || "",
				note: client.churn_note || "",
				at: client.churned_at ? String(client.churned_at).slice(0, 10) : ""
			},
			tags: normalizeClientTags(client.tags),
			accountFocus: normalizeAccountFocus(client.account_focus),
			profile: {
				stage: client.stage || "Active",
				fullName: client.full_name || client.name,
				email: client.email || "",
				phone: client.phone || "",
				timezone: client.timezone || "",
				country: client.country || "",
				startDate: client.start_date || "",
				preferredChannel: client.preferred_channel || "",
				language: client.language || "",
				productKey: client.product_key || "",
				additionalEmails: jsonArray(client.additional_emails),
				propFirm: client.prop_firm || "",
				messenger: client.messenger || "",
				subscriptionPrice: normalizeSubscriptionPrice(client.subscription_price)
			},
			credentials: {
				ip: credential.ip || "",
				username: credential.username || "",
				password: credential.password_encrypted || "",
				ntLogin: credential.nt_login || "",
				ntPassword: credential.nt_password_encrypted || "",
				firmLogin: credential.firm_login || "",
				firmPassword: credential.firm_password_encrypted || "",
				notes: credential.notes || ""
			},
			propFirms: (propFirmsByClient[client.id] || []).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
			accountRegistry,
			dailyImports,
			activityLog: (activityByClient[client.id] || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
			tasks: (tasksByClient[client.id] || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
			priceChecks: priceChecksByClient[client.id] || [],
			priceChecksDate: ""
		};
	});
	const selectedClientId = preferredCam?.clientIds?.[0] || clients[0]?.id || null;
	const storedSummaries = (summaryRows || []).map(closeSummaryFromRow);
	const closeSummaries = storedSummaries.length || !deriveMissingSummaries ? storedSummaries : clients.flatMap((client) => (client.dailyImports || []).flatMap((dailyImport) => buildCloseSummaryRows({
		accountRegistry: client.accountRegistry,
		dailyImport
	}).map((row) => ({
		...row,
		dailyImportId: dailyImport.uuid || dailyImport.id,
		clientUuid: client.uuid || client.id,
		date: dailyImport.date
	}))));
	const camIdByUuid = Object.fromEntries((camRows || []).map((row) => [row.id, pickId(row)]));
	const clientIdByUuid = Object.fromEntries((clientRows || []).map((row) => [row.id, pickId(row)]));
	return {
		dataSource: "supabase",
		accountManager: {
			id: preferredCam?.id || "",
			name: preferredCam?.name || "Unassigned"
		},
		camProfiles,
		clients,
		hiddenClientCount,
		closeSummaries: attachClientIds(closeSummaries, clientIdByUuid),
		timeOff: (timeOffRows || []).map((row) => timeOffFromRow(row, camIdByUuid)),
		coverage: (coverageRows || []).map((row) => coverageFromRow(row, camIdByUuid, clientIdByUuid)),
		selectedClientId
	};
}
function numberOrNull$1(value) {
	if (value === "" || value == null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function jsonArray(value) {
	return Array.isArray(value) ? value : [];
}
//#endregion
//#region ../../../../../../../../Users/pedro/Developer/CAM-CRM-Vincere/node_modules/fflate/esm/browser.js
var u8 = Uint8Array, u16 = Uint16Array, i32 = Int32Array;
var fleb = new u8([
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	1,
	1,
	1,
	1,
	2,
	2,
	2,
	2,
	3,
	3,
	3,
	3,
	4,
	4,
	4,
	4,
	5,
	5,
	5,
	5,
	0,
	0,
	0,
	0
]);
var fdeb = new u8([
	0,
	0,
	0,
	0,
	1,
	1,
	2,
	2,
	3,
	3,
	4,
	4,
	5,
	5,
	6,
	6,
	7,
	7,
	8,
	8,
	9,
	9,
	10,
	10,
	11,
	11,
	12,
	12,
	13,
	13,
	0,
	0
]);
var clim = new u8([
	16,
	17,
	18,
	0,
	8,
	7,
	9,
	6,
	10,
	5,
	11,
	4,
	12,
	3,
	13,
	2,
	14,
	1,
	15
]);
var freb = function(eb, start) {
	var b = new u16(31);
	for (var i = 0; i < 31; ++i) b[i] = start += 1 << eb[i - 1];
	var r = new i32(b[30]);
	for (var i = 1; i < 30; ++i) for (var j = b[i]; j < b[i + 1]; ++j) r[j] = j - b[i] << 5 | i;
	return {
		b,
		r
	};
};
var _a = freb(fleb, 2), fl = _a.b, revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
_b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (var i = 0; i < 32768; ++i) {
	var x = (i & 43690) >> 1 | (i & 21845) << 1;
	x = (x & 52428) >> 2 | (x & 13107) << 2;
	x = (x & 61680) >> 4 | (x & 3855) << 4;
	rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var hMap = (function(cd, mb, r) {
	var s = cd.length;
	var i = 0;
	var l = new u16(mb);
	for (; i < s; ++i) if (cd[i]) ++l[cd[i] - 1];
	var le = new u16(mb);
	for (i = 1; i < mb; ++i) le[i] = le[i - 1] + l[i - 1] << 1;
	var co;
	if (r) {
		co = new u16(1 << mb);
		var rvb = 15 - mb;
		for (i = 0; i < s; ++i) if (cd[i]) {
			var sv = i << 4 | cd[i];
			var r_1 = mb - cd[i];
			var v = le[cd[i] - 1]++ << r_1;
			for (var m = v | (1 << r_1) - 1; v <= m; ++v) co[rev[v] >> rvb] = sv;
		}
	} else {
		co = new u16(s);
		for (i = 0; i < s; ++i) if (cd[i]) co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
	}
	return co;
});
var flt = new u8(288);
for (var i = 0; i < 144; ++i) flt[i] = 8;
for (var i = 144; i < 256; ++i) flt[i] = 9;
for (var i = 256; i < 280; ++i) flt[i] = 7;
for (var i = 280; i < 288; ++i) flt[i] = 8;
var fdt = new u8(32);
for (var i = 0; i < 32; ++i) fdt[i] = 5;
var flm = /*#__PURE__*/ hMap(flt, 9, 0), fdm = /*#__PURE__*/ hMap(fdt, 5, 0);
var shft = function(p) {
	return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
	if (s == null || s < 0) s = 0;
	if (e == null || e > v.length) e = v.length;
	return new u8(v.subarray(s, e));
};
var ec = [
	"unexpected EOF",
	"invalid block type",
	"invalid length/literal",
	"invalid distance",
	"stream finished",
	"no stream handler",
	,
	"no callback",
	"invalid UTF-8 data",
	"extra field too long",
	"date not in range 1980-2099",
	"filename too long",
	"stream finishing",
	"invalid zip data"
];
var err = function(ind, msg, nt) {
	var e = new Error(msg || ec[ind]);
	e.code = ind;
	if (Error.captureStackTrace) Error.captureStackTrace(e, err);
	if (!nt) throw e;
	return e;
};
var wbits = function(d, p, v) {
	v <<= p & 7;
	var o = p / 8 | 0;
	d[o] |= v;
	d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
	v <<= p & 7;
	var o = p / 8 | 0;
	d[o] |= v;
	d[o + 1] |= v >> 8;
	d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
	var t = [];
	for (var i = 0; i < d.length; ++i) if (d[i]) t.push({
		s: i,
		f: d[i]
	});
	var s = t.length;
	var t2 = t.slice();
	if (!s) return {
		t: et,
		l: 0
	};
	if (s == 1) {
		var v = new u8(t[0].s + 1);
		v[t[0].s] = 1;
		return {
			t: v,
			l: 1
		};
	}
	t.sort(function(a, b) {
		return a.f - b.f;
	});
	t.push({
		s: -1,
		f: 25001
	});
	var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
	t[0] = {
		s: -1,
		f: l.f + r.f,
		l,
		r
	};
	while (i1 != s - 1) {
		l = t[t[i0].f < t[i2].f ? i0++ : i2++];
		r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
		t[i1++] = {
			s: -1,
			f: l.f + r.f,
			l,
			r
		};
	}
	var maxSym = t2[0].s;
	for (var i = 1; i < s; ++i) if (t2[i].s > maxSym) maxSym = t2[i].s;
	var tr = new u16(maxSym + 1);
	var mbt = ln(t[i1 - 1], tr, 0);
	if (mbt > mb) {
		var i = 0, dt = 0;
		var lft = mbt - mb, cst = 1 << lft;
		t2.sort(function(a, b) {
			return tr[b.s] - tr[a.s] || a.f - b.f;
		});
		for (; i < s; ++i) {
			var i2_1 = t2[i].s;
			if (tr[i2_1] > mb) {
				dt += cst - (1 << mbt - tr[i2_1]);
				tr[i2_1] = mb;
			} else break;
		}
		dt >>= lft;
		while (dt > 0) {
			var i2_2 = t2[i].s;
			if (tr[i2_2] < mb) dt -= 1 << mb - tr[i2_2]++ - 1;
			else ++i;
		}
		for (; i >= 0 && dt; --i) {
			var i2_3 = t2[i].s;
			if (tr[i2_3] == mb) {
				--tr[i2_3];
				++dt;
			}
		}
		mbt = mb;
	}
	return {
		t: new u8(tr),
		l: mbt
	};
};
var ln = function(n, l, d) {
	return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
	var s = c.length;
	while (s && !c[--s]);
	var cl = new u16(++s);
	var cli = 0, cln = c[0], cls = 1;
	var w = function(v) {
		cl[cli++] = v;
	};
	for (var i = 1; i <= s; ++i) if (c[i] == cln && i != s) ++cls;
	else {
		if (!cln && cls > 2) {
			for (; cls > 138; cls -= 138) w(32754);
			if (cls > 2) {
				w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
				cls = 0;
			}
		} else if (cls > 3) {
			w(cln), --cls;
			for (; cls > 6; cls -= 6) w(8304);
			if (cls > 2) w(cls - 3 << 5 | 8208), cls = 0;
		}
		while (cls--) w(cln);
		cls = 1;
		cln = c[i];
	}
	return {
		c: cl.subarray(0, cli),
		n: s
	};
};
var clen = function(cf, cl) {
	var l = 0;
	for (var i = 0; i < cl.length; ++i) l += cf[i] * cl[i];
	return l;
};
var wfblk = function(out, pos, dat) {
	var s = dat.length;
	var o = shft(pos + 2);
	out[o] = s & 255;
	out[o + 1] = s >> 8;
	out[o + 2] = out[o] ^ 255;
	out[o + 3] = out[o + 1] ^ 255;
	for (var i = 0; i < s; ++i) out[o + i + 4] = dat[i];
	return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
	wbits(out, p++, final);
	++lf[256];
	var _a = hTree(lf, 15), dlt = _a.t, mlb = _a.l;
	var _b = hTree(df, 15), ddt = _b.t, mdb = _b.l;
	var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
	var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
	var lcfreq = new u16(19);
	for (var i = 0; i < lclt.length; ++i) ++lcfreq[lclt[i] & 31];
	for (var i = 0; i < lcdt.length; ++i) ++lcfreq[lcdt[i] & 31];
	var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
	var nlcc = 19;
	for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc);
	var flen = bl + 5 << 3;
	var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
	var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
	if (bs >= 0 && flen <= ftlen && flen <= dtlen) return wfblk(out, p, dat.subarray(bs, bs + bl));
	var lm, ll, dm, dl;
	wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
	if (dtlen < ftlen) {
		lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
		var llm = hMap(lct, mlcb, 0);
		wbits(out, p, nlc - 257);
		wbits(out, p + 5, ndc - 1);
		wbits(out, p + 10, nlcc - 4);
		p += 14;
		for (var i = 0; i < nlcc; ++i) wbits(out, p + 3 * i, lct[clim[i]]);
		p += 3 * nlcc;
		var lcts = [lclt, lcdt];
		for (var it = 0; it < 2; ++it) {
			var clct = lcts[it];
			for (var i = 0; i < clct.length; ++i) {
				var len = clct[i] & 31;
				wbits(out, p, llm[len]), p += lct[len];
				if (len > 15) wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
			}
		}
	} else lm = flm, ll = flt, dm = fdm, dl = fdt;
	for (var i = 0; i < li; ++i) {
		var sym = syms[i];
		if (sym > 255) {
			var len = sym >> 18 & 31;
			wbits16(out, p, lm[len + 257]), p += ll[len + 257];
			if (len > 7) wbits(out, p, sym >> 23 & 31), p += fleb[len];
			var dst = sym & 31;
			wbits16(out, p, dm[dst]), p += dl[dst];
			if (dst > 3) wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
		} else wbits16(out, p, lm[sym]), p += ll[sym];
	}
	wbits16(out, p, lm[256]);
	return p + ll[256];
};
var deo = /*#__PURE__*/ new i32([
	65540,
	131080,
	131088,
	131104,
	262176,
	1048704,
	1048832,
	2114560,
	2117632
]);
var et = /*#__PURE__*/ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
	var s = st.z || dat.length;
	var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
	var w = o.subarray(pre, o.length - post);
	var lst = st.l;
	var pos = (st.r || 0) & 7;
	if (lvl) {
		if (pos) w[0] = st.r >> 3;
		var opt = deo[lvl - 1];
		var n = opt >> 13, c = opt & 8191;
		var msk_1 = (1 << plvl) - 1;
		var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
		var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
		var hsh = function(i) {
			return (dat[i] ^ dat[i + 1] << bs1_1 ^ dat[i + 2] << bs2_1) & msk_1;
		};
		var syms = new i32(25e3);
		var lf = new u16(288), df = new u16(32);
		var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
		for (; i + 2 < s; ++i) {
			var hv = hsh(i);
			var imod = i & 32767, pimod = head[hv];
			prev[imod] = pimod;
			head[hv] = imod;
			if (wi <= i) {
				var rem = s - i;
				if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
					pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
					li = lc_1 = eb = 0, bs = i;
					for (var j = 0; j < 286; ++j) lf[j] = 0;
					for (var j = 0; j < 30; ++j) df[j] = 0;
				}
				var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
				if (rem > 2 && hv == hsh(i - dif)) {
					var maxn = Math.min(n, rem) - 1;
					var maxd = Math.min(32767, i);
					var ml = Math.min(258, rem);
					while (dif <= maxd && --ch_1 && imod != pimod) {
						if (dat[i + l] == dat[i + l - dif]) {
							var nl = 0;
							for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl);
							if (nl > l) {
								l = nl, d = dif;
								if (nl > maxn) break;
								var mmd = Math.min(dif, nl - 2);
								var md = 0;
								for (var j = 0; j < mmd; ++j) {
									var ti = i - dif + j & 32767;
									var cd = ti - prev[ti] & 32767;
									if (cd > md) md = cd, pimod = ti;
								}
							}
						}
						imod = pimod, pimod = prev[imod];
						dif += imod - pimod & 32767;
					}
				}
				if (d) {
					syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
					var lin = revfl[l] & 31, din = revfd[d] & 31;
					eb += fleb[lin] + fdeb[din];
					++lf[257 + lin];
					++df[din];
					wi = i + l;
					++lc_1;
				} else {
					syms[li++] = dat[i];
					++lf[dat[i]];
				}
			}
		}
		for (i = Math.max(i, wi); i < s; ++i) {
			syms[li++] = dat[i];
			++lf[dat[i]];
		}
		pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
		if (!lst) {
			st.r = pos & 7 | w[pos / 8 | 0] << 3;
			pos -= 7;
			st.h = head, st.p = prev, st.i = i, st.w = wi;
		}
	} else {
		for (var i = st.w || 0; i < s + lst; i += 65535) {
			var e = i + 65535;
			if (e >= s) {
				w[pos / 8 | 0] = lst;
				e = s;
			}
			pos = wfblk(w, pos + 1, dat.subarray(i, e));
		}
		st.i = s;
	}
	return slc(o, 0, pre + shft(pos) + post);
};
var crct = /*#__PURE__*/ (function() {
	var t = /* @__PURE__ */ new Int32Array(256);
	for (var i = 0; i < 256; ++i) {
		var c = i, k = 9;
		while (--k) c = (c & 1 && -306674912) ^ c >>> 1;
		t[i] = c;
	}
	return t;
})();
var crc = function() {
	var c = -1;
	return {
		p: function(d) {
			var cr = c;
			for (var i = 0; i < d.length; ++i) cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
			c = cr;
		},
		d: function() {
			return ~c;
		}
	};
};
var dopt = function(dat, opt, pre, post, st) {
	if (!st) {
		st = { l: 1 };
		if (opt.dictionary) {
			var dict = opt.dictionary.subarray(-32768);
			var newDat = new u8(dict.length + dat.length);
			newDat.set(dict);
			newDat.set(dat, dict.length);
			dat = newDat;
			st.w = dict.length;
		}
	}
	return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
	var o = {};
	for (var k in a) o[k] = a[k];
	for (var k in b) o[k] = b[k];
	return o;
};
var wbytes = function(d, b, v) {
	for (; v; ++b) d[b] = v, v >>>= 8;
};
/**
* Compresses data with DEFLATE without any wrapper
* @param data The data to compress
* @param opts The compression options
* @returns The deflated version of the data
*/
function deflateSync(data, opts) {
	return dopt(data, opts || {}, 0, 0);
}
var fltn = function(d, p, t, o) {
	for (var k in d) {
		var val = d[k], n = p + k, op = o;
		if (Array.isArray(val)) op = mrg(o, val[1]), val = val[0];
		if (ArrayBuffer.isView(val)) t[n] = [val, op];
		else {
			t[n += "/"] = [new u8(0), op];
			fltn(val, n, t, o);
		}
	}
};
var te = typeof TextEncoder != "undefined" && /*#__PURE__*/ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /*#__PURE__*/ new TextDecoder();
try {
	td.decode(et, { stream: true });
} catch (e) {}
/**
* Converts a string into a Uint8Array for use with compression/decompression methods
* @param str The string to encode
* @param latin1 Whether or not to interpret the data as Latin-1. This should
*               not need to be true unless decoding a binary string.
* @returns The string encoded in UTF-8/Latin-1 binary
*/
function strToU8(str, latin1) {
	if (latin1) {
		var ar_1 = new u8(str.length);
		for (var i = 0; i < str.length; ++i) ar_1[i] = str.charCodeAt(i);
		return ar_1;
	}
	if (te) return te.encode(str);
	var l = str.length;
	var ar = new u8(str.length + (str.length >> 1));
	var ai = 0;
	var w = function(v) {
		ar[ai++] = v;
	};
	for (var i = 0; i < l; ++i) {
		if (ai + 5 > ar.length) {
			var n = new u8(ai + 8 + (l - i << 1));
			n.set(ar);
			ar = n;
		}
		var c = str.charCodeAt(i);
		if (c < 128 || latin1) w(c);
		else if (c < 2048) w(192 | c >> 6), w(128 | c & 63);
		else if (c > 55295 && c < 57344) c = 65536 + (c & 1047552) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
		else w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
	}
	return slc(ar, 0, ai);
}
var exfl = function(ex) {
	var le = 0;
	if (ex) for (var k in ex) {
		var l = ex[k].length;
		if (l > 65535) err(9);
		le += l + 4;
	}
	return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
	var fl = fn.length, ex = f.extra, col = co && co.length;
	var exl = exfl(ex);
	wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
	if (ce != null) d[b++] = 20, d[b++] = f.os;
	d[b] = 20, b += 2;
	d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
	d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
	var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
	if (y < 0 || y > 119) err(10);
	wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
	if (c != -1) {
		wbytes(d, b, f.crc);
		wbytes(d, b + 4, c < 0 ? -c - 2 : c);
		wbytes(d, b + 8, f.size);
	}
	wbytes(d, b + 12, fl);
	wbytes(d, b + 14, exl), b += 16;
	if (ce != null) {
		wbytes(d, b, col);
		wbytes(d, b + 6, f.attrs);
		wbytes(d, b + 10, ce), b += 14;
	}
	d.set(fn, b);
	b += fl;
	if (exl) for (var k in ex) {
		var exf = ex[k], l = exf.length;
		wbytes(d, b, +k);
		wbytes(d, b + 2, l);
		d.set(exf, b + 4), b += 4 + l;
	}
	if (col) d.set(co, b), b += col;
	return b;
};
var wzf = function(o, b, c, d, e) {
	wbytes(o, b, 101010256);
	wbytes(o, b + 8, c);
	wbytes(o, b + 10, c);
	wbytes(o, b + 12, d);
	wbytes(o, b + 16, e);
};
/**
* Synchronously creates a ZIP file. Prefer using `zip` for better performance
* with more than one file.
* @param data The directory structure for the ZIP archive
* @param opts The main options, merged with per-file options
* @returns The generated ZIP archive
*/
function zipSync(data, opts) {
	if (!opts) opts = {};
	var r = {};
	var files = [];
	fltn(data, "", r, opts);
	var o = 0;
	var tot = 0;
	for (var fn in r) {
		var _a = r[fn], file = _a[0], p = _a[1];
		var compression = p.level == 0 ? 0 : 8;
		var f = strToU8(fn), s = f.length;
		var com = p.comment, m = com && strToU8(com), ms = m && m.length;
		var exl = exfl(p.extra);
		if (s > 65535) err(11);
		var d = compression ? deflateSync(file, p) : file, l = d.length;
		var c = crc();
		c.p(file);
		files.push(mrg(p, {
			size: file.length,
			crc: c.d(),
			c: d,
			f,
			m,
			u: s != fn.length || m && com.length != ms,
			o,
			compression
		}));
		o += 30 + s + exl + l;
		tot += 76 + 2 * (s + exl) + (ms || 0) + l;
	}
	var out = new u8(tot + 22), oe = o, cdl = tot - o;
	for (var i = 0; i < files.length; ++i) {
		var f = files[i];
		wzh(out, f.o, f, f.f, f.u, f.c.length);
		var badd = 30 + f.f.length + exfl(f.extra);
		out.set(f.c, f.o + badd);
		wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
	}
	wzf(out, o, files.length, cdl, oe);
	return out;
}
//#endregion
//#region src/domain/clientSegments.js
function accountMetaFor(client, dailyImport, accountName) {
	const lower = String(accountName || "").toLowerCase();
	const fromImport = Object.entries(dailyImport?.accounts || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
	const fromRegistry = Object.entries(client?.accountRegistry || {}).find(([k]) => k.toLowerCase() === lower)?.[1] || {};
	return {
		...fromImport,
		...fromRegistry
	};
}
function segmentKey(accountType) {
	if (accountType === ACCOUNT_TYPES.FUNDED) return "funded";
	if (accountType === ACCOUNT_TYPES.CASH_IRA) return "cashIra";
	if (accountType === ACCOUNT_TYPES.CASH_STRAIGHT) return "cashStraight";
	if (isCashType(accountType)) return "cashLegacy";
	if (accountType === ACCOUNT_TYPES.EVALUATION_BULLET) return "bulletBot";
	if (accountType === ACCOUNT_TYPES.EVALUATION_STANDARD) return "evalStandard";
	return "other";
}
function buildClientSegments(client, dailyImport) {
	const empty = () => ({
		balance: 0,
		dailyPnl: 0,
		weeklyPnl: 0,
		count: 0,
		accounts: []
	});
	const segments = {
		funded: empty(),
		cash: empty(),
		cashIra: empty(),
		cashStraight: empty(),
		cashLegacy: empty(),
		evalStandard: empty(),
		bulletBot: empty(),
		other: empty(),
		simulation: empty(),
		undetermined: empty()
	};
	for (const snapshot of dailyImport?.snapshots || []) {
		const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
		const key = segmentKey(meta.accountType);
		const buckets = [segments[key]];
		if (key === "cashIra" || key === "cashStraight" || key === "cashLegacy") buckets.push(segments.cash);
		const balance = Number(snapshot.accountBalance) || 0;
		const dailyPnl = Number(snapshot.grossRealizedPnl) || 0;
		const weeklyPnl = Number(snapshot.weeklyPnl) || 0;
		const trailing = Number(snapshot.trailingMaxDrawdown) || 0;
		for (const seg of buckets) {
			seg.balance += balance;
			seg.dailyPnl += dailyPnl;
			seg.weeklyPnl += weeklyPnl;
			seg.count += 1;
			seg.accounts.push({
				accountName: snapshot.accountName,
				alias: meta.alias || snapshot.accountName,
				accountType: meta.accountType || "",
				balance,
				dailyPnl,
				weeklyPnl,
				trailing,
				connection: snapshot.connection || ""
			});
		}
	}
	const notMoney = [[
		segments.simulation,
		dailyImport?.simulation?.snapshots || [],
		ACCOUNT_NATURES.SIMULATION
	], [
		segments.undetermined,
		dailyImport?.simulation?.undetermined?.snapshots || [],
		ACCOUNT_NATURES.UNDETERMINED
	]];
	for (const [bucket, snapshots, nature] of notMoney) for (const snapshot of snapshots) {
		const meta = accountMetaFor(client, dailyImport, snapshot.accountName);
		const balance = Number(snapshot.accountBalance) || 0;
		const dailyPnl = Number(snapshot.grossRealizedPnl) || 0;
		const weeklyPnl = Number(snapshot.weeklyPnl) || 0;
		const classification = classifyAccountNature(meta, { accountName: snapshot.accountName });
		bucket.balance += balance;
		bucket.dailyPnl += dailyPnl;
		bucket.weeklyPnl += weeklyPnl;
		bucket.count += 1;
		bucket.accounts.push({
			accountName: snapshot.accountName,
			alias: meta.alias || snapshot.accountName,
			accountType: meta.accountType || "",
			balance,
			dailyPnl,
			weeklyPnl,
			trailing: null,
			connection: snapshot.connection || "",
			nature,
			natureReason: classification.reason,
			natureSource: classification.source,
			heuristic: classification.heuristic
		});
	}
	return segments;
}
//#endregion
//#region src/domain/accountTargets.js
var TARGET_TABLE = {
	standard: {
		5e4: 54100,
		1e5: 107300,
		15e4: 159e3
	},
	bulletBot: { 5e4: 53e3 }
};
function targetForAccount(accountType, startingBalance) {
	if (isCashType(accountType)) return null;
	if (isSimulationAccountType(accountType)) return null;
	return TARGET_TABLE[accountType === ACCOUNT_TYPES.EVALUATION_BULLET ? "bulletBot" : "standard"][Number(startingBalance)] ?? null;
}
//#endregion
//#region src/domain/evaluationReport.js
/** True for both evaluation types, and for neither funded nor cash nor sim. */
function isEvaluationType(accountType) {
	return String(accountType || "").startsWith("Evaluation");
}
/**
* Why a row has no progress figure, or that it has one.
*
* Five outcomes rather than a percentage and a blank, because a 0% and "nobody
* has recorded what this account has to reach" are different facts and only one
* of them is about the client's trading.
*/
var EVALUATION_PROGRESS = {
	/** On its way: `percent` is meaningful. */
	BELOW: "below",
	/**
	* Balance is at or past the target. "Reached", never "passed": the firm
	* decides whether an evaluation passed, and it also checks minimum days and
	* consistency rules this CRM does not hold. The desk's own panel settled this
	* vocabulary first (bulletBotDeskStats.js) and the report follows it.
	*/
	REACHED: "reached",
	/**
	* A target is on record and it is at or below the account's own starting
	* balance, so the account is "100% there" the day it opens. 18 of the book's
	* 289 evaluation accounts are in this state. Neither 0% nor 100% is true, so
	* neither is printed.
	*/
	TARGET_NOT_ABOVE_START: "target-not-above-start",
	/** No starting balance stored and no close on record to take one from. */
	NO_START: "no-start",
	/** No stored target and no standard target for this type at this size. */
	NO_TARGET: "no-target"
};
var positive = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : null;
};
/**
* The absolute target BALANCE for one evaluation row, and where it came from.
*
* Stored first — someone typed it deliberately. Then the standard target for the
* account's type at its inferred size, which is the same table
* `suggestAccountDefaults` pre-fills from, so a derived figure here can never
* disagree with the one a CAM would have been offered. Nothing else: see the
* header on why the firm-rule fallback is refused.
*/
function evaluationTargetFor(meta, startBalance) {
	const gate = storedTargetStatus(meta);
	if (gate.target) return {
		target: gate.target,
		source: "stored"
	};
	if (gate.state !== STORED_TARGET.NONE) return {
		target: null,
		source: null,
		refused: gate.state,
		stored: gate.stored
	};
	const size = inferStartingBalance(startBalance);
	const standard = size != null ? targetForAccount(meta?.accountType, size) : null;
	if (standard) return {
		target: standard,
		source: "inferred"
	};
	return {
		target: null,
		source: null
	};
}
/**
* How far one evaluation row is from its target.
*
* @param {object} row a `grouped.evaluations` row (snapshot + `meta`)
* @param {object[]} dailyImports the client's closes, for the earliest balance
*   on record when the account carries no stored start. That fallback is what
*   takes start coverage from 129 of 289 accounts to all 289.
*/
function evaluationProgressFor(row, dailyImports = []) {
	const storedStart = positive(row?.meta?.startBalance);
	const observedStart = storedStart ? null : firstObservedBalance(row?.accountName, dailyImports);
	const start = storedStart || positive(observedStart);
	const startSource = storedStart ? "stored" : start ? "observed" : null;
	const { target, source: targetSource, refused, stored } = evaluationTargetFor(row?.meta, start);
	const balance = Number(row?.accountBalance || 0);
	const base = {
		start,
		startSource,
		target,
		targetSource,
		percent: null
	};
	if (refused === STORED_TARGET.NOT_ABOVE_START) return {
		...base,
		target: stored,
		targetSource: "stored",
		state: EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START
	};
	if (!target) return {
		...base,
		state: EVALUATION_PROGRESS.NO_TARGET
	};
	if (!start) return {
		...base,
		state: EVALUATION_PROGRESS.NO_START
	};
	if (target <= start) return {
		...base,
		state: EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START
	};
	if (balance >= target) return {
		...base,
		state: EVALUATION_PROGRESS.REACHED,
		percent: 100
	};
	const percent = Math.max(0, Math.min(100, Math.round((balance - start) / (target - start) * 100)));
	return {
		...base,
		state: EVALUATION_PROGRESS.BELOW,
		percent
	};
}
var COUNTABLE = /* @__PURE__ */ new Set([EVALUATION_PROGRESS.BELOW, EVALUATION_PROGRESS.REACHED]);
/**
* The evaluations block, or null when the client has no evaluation account at
* all — absence of a section, not a section full of zeros, which is the rule
* SimulationReportSection set.
*
* It does NOT return null merely because no evaluation filed a close today. A
* client who holds three challenge accounts and saw none of them report is owed
* that sentence; 3 of the 50 book clients with evaluations are in that state on
* their latest close. That is a fact about the client's own accounts, unlike "no
* account here is classified as simulation", which is a fact about the desk's
* data entry and belongs in the designer, not on the paper.
*
* @param {number} reportedAccountCount every close on this import, so every
*   count can be printed against its denominator.
*/
function buildEvaluationSection(client, dailyImport, { rows = [], totals = null, reportedAccountCount = 0 } = {}) {
	const registry = {
		...dailyImport?.accounts || {},
		...client?.accountRegistry || {}
	};
	const onRecord = Object.values(registry).filter((meta) => isEvaluationType(meta?.accountType)).length;
	if (!onRecord && !rows.length) return null;
	const dailyImports = client?.dailyImports || [];
	const accounts = rows.map((row) => {
		const progress = evaluationProgressFor(row, dailyImports);
		const ran = (row.strategies || []).filter((strategy) => strategyRan(strategy));
		return {
			...row,
			progress,
			ranStrategies: ran.map((strategy) => strategy.strategyFamily || strategy.strategyName || "Strategy"),
			reportedBuffer: Number(row.trailingMaxDrawdown || 0) > 0 ? Number(row.trailingMaxDrawdown) : null,
			pastDrawdown: Number(row.trailingMaxDrawdown || 0) < 0
		};
	});
	const traded = accounts.filter((row) => row.ranStrategies.length).length;
	const flat = accounts.filter((row) => Number(row.grossRealizedPnl || 0) === 0).length;
	const reached = accounts.filter((row) => row.progress.state === EVALUATION_PROGRESS.REACHED).length;
	const failed = accounts.filter((row) => row.meta?.status === "Failed").length;
	return {
		/**
		* THE HEADING COUNTS THE ROWS UNDER IT, and where there are none it says so
		* in words instead of printing a nought.
		*
		* `(n)` is the number of rows the block shows — the same count the chat
		* block has printed since report.js:205 and the same one the subtotal's
		* denominator is read against, so the number is the right one and it stays.
		* The WORD was wrong. A reader takes a figure in a heading for a count of
		* the client's accounts, not of today's rows, so "Evaluations (0)" over a
		* sentence reading "3 evaluation accounts on record" asserted the opposite
		* of its own body at a glance. 19 closes on the book print that pair, 4 of
		* them a client's latest close, and it prints on the PDF.
		*/
		label: accounts.length ? `Evaluations (${accounts.length})` : "Evaluations (none reported today)",
		/**
		* The words that say what the money is. Currency formatting alone does not
		* carry "this is not yours", so the sentence does, and the column headings
		* repeat it beside every figure.
		*
		* The none-reported branch agrees with its own number: one account is "it",
		* not "none of them". 5 of the 51 clients holding an evaluation account hold
		* exactly one, and 5 of the 19 closes that print this sentence are theirs.
		*/
		note: accounts.length ? "These are challenge accounts. The capital in them belongs to the prop firm, not to you — what matters is whether each one reaches its target. Their balances and results are shown separately and are not included in any figure above." : onRecord === 1 ? "1 evaluation account on record, and it reported no close on this date, so there is nothing to show for it today." : `${onRecord} evaluation accounts on record, and none of them reported a close on this date, so there is nothing to show for them today.`,
		hasRows: accounts.length > 0,
		accounts,
		totals: totals || {
			grossRealizedPnl: 0,
			weeklyPnl: 0,
			aggregateBalance: 0
		},
		counts: {
			accounts: accounts.length,
			onRecord,
			/** On record and silent today. 16 of 329 closes on the book. */
			notReported: Math.max(0, onRecord - accounts.length),
			ofAccountsReported: reportedAccountCount,
			traded,
			/** Reported, and no strategy ran: 164 of 203 rows on the book's latest closes. */
			idle: accounts.length - traded,
			flat,
			reached,
			failed
		},
		/**
		* How empty the progress column is, printed above it.
		*
		* The pattern is bulletBotDeskStats.buildColumnCoverage: a rate drawn from a
		* partly-filled column is stated with its denominator and with how much of
		* the column was filled, because the desk that owns `target_profit` and
		* `start_balance` reads the panel, not the comment.
		*/
		coverage: {
			ofAccounts: accounts.length,
			progressShown: accounts.filter((row) => COUNTABLE.has(row.progress.state)).length,
			targetStored: accounts.filter((row) => row.progress.targetSource === "stored").length,
			targetInferred: accounts.filter((row) => row.progress.targetSource === "inferred").length,
			targetMissing: accounts.filter((row) => !row.progress.target).length,
			startStored: accounts.filter((row) => row.progress.startSource === "stored").length,
			startObserved: accounts.filter((row) => row.progress.startSource === "observed").length,
			/**
			* The rows whose PERCENTAGE rests on a start nobody typed.
			*
			* Narrower than `startObserved` on purpose: the start is a denominator only
			* in the BELOW branch. A row reading "Target reached" compares a balance
			* against a target and the start never enters it, so an inferred start
			* there is not a figure anybody reads. 82 of the 186 bars on the book's
			* latest closes are in this state, and until the cell said so the reader
			* could not tell which.
			*/
			percentFromObservedStart: accounts.filter((row) => row.progress.state === EVALUATION_PROGRESS.BELOW && row.progress.startSource === "observed").length,
			targetNotAboveStart: accounts.filter((row) => row.progress.state === EVALUATION_PROGRESS.TARGET_NOT_ABOVE_START).length,
			bufferReported: accounts.filter((row) => row.reportedBuffer !== null).length,
			bufferPastDrawdown: accounts.filter((row) => row.pastDrawdown).length
		}
	};
}
//#endregion
//#region src/domain/report.js
function ciLookup(registry, accountName) {
	if (!registry || !accountName) return {};
	if (registry[accountName]) return registry[accountName];
	const lower = accountName.toLowerCase();
	const key = Object.keys(registry).find((k) => k.toLowerCase() === lower);
	return key ? registry[key] : {};
}
function formatCurrency(value) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0
	}).format(Number(value || 0));
}
function summarizeAccountRows(rows = []) {
	return {
		totals: rows.reduce((acc, item) => ({
			grossRealizedPnl: acc.grossRealizedPnl + Number(item.grossRealizedPnl || 0),
			weeklyPnl: acc.weeklyPnl + Number(item.weeklyPnl || 0),
			aggregateBalance: acc.aggregateBalance + Number(item.accountBalance || 0),
			unrealizedPnl: acc.unrealizedPnl + Number(item.unrealizedPnl || 0)
		}), {
			grossRealizedPnl: 0,
			weeklyPnl: 0,
			aggregateBalance: 0,
			unrealizedPnl: 0
		}),
		counts: { accounts: rows.length }
	};
}
function buildClientMessageReport(client, dailyImport) {
	const summary = buildDailyReportSummary(client, dailyImport);
	const grouped = summary?.grouped || {};
	const sign = (n) => n >= 0 ? "+" : "";
	const fmt = (n) => formatCurrency(n);
	const date = dailyImport?.date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	const lines = [];
	lines.push(`📊 *Daily Update - ${date}*`);
	lines.push(`👤 ${client?.name || "Client"}`);
	lines.push("");
	lines.push(`💰 *Daily P&L:* ${sign(summary.totals.grossRealizedPnl)}${fmt(summary.totals.grossRealizedPnl)}`);
	lines.push(`📈 *Weekly P&L:* ${sign(summary.totals.weeklyPnl)}${fmt(summary.totals.weeklyPnl)}`);
	lines.push("");
	const fundedLine = (row) => {
		const alias = row.meta?.alias || row.accountName;
		const drawdown = Number(row.trailingMaxDrawdown || 0);
		const pnl = Number(row.grossRealizedPnl || 0);
		const ran = (row.strategies || []).filter((strategy) => strategyRan(strategy)).map((strategy) => strategy.strategyFamily || strategy.strategyName).join(", ");
		return `  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily${drawdown > 0 ? ` | Buffer: ${fmt(drawdown)}` : ""}${ran ? ` | ${ran}` : ""}`;
	};
	const plainLine = (row) => {
		const alias = row.meta?.alias || row.accountName;
		const pnl = Number(row.grossRealizedPnl || 0);
		return `  • ${alias}: ${sign(pnl)}${fmt(pnl)} daily`;
	};
	const block = (heading, rows, line) => {
		if (!rows?.length) return;
		lines.push(heading(rows.length));
		for (const row of rows) lines.push(line(row));
		lines.push("");
	};
	block((n) => `✅ *Funded Accounts (${n}):*`, grouped.funded, fundedLine);
	block((n) => `💵 *Cash Accounts (${n}):*`, grouped.cash, plainLine);
	block((n) => `📁 *Other Accounts (${n}):*`, grouped.unclassified, plainLine);
	block((n) => `🔄 *Evaluations (${n}):*`, grouped.evaluations, plainLine);
	lines.push("_Any questions? Reply to this message._");
	return lines.join("\n");
}
/**
* The simulation block of a client report: its own accounts, its own balance,
* its own performance, and the words that say it is not money.
*
* Written because the report the desk actually sent Craig Weschke on 2026-08-06
* read `ACCOUNTS 2 · DAILY REALIZED PNL $0 · WEEKLY PNL $0` while his Sim101 —
* the only account of his that traded that day — ran 40 orders and 15 executions
* for a realized -$1,297.9999999 on two enabled strategies, and his CAM had
* hand-written a note to him about exactly that session. The desk could not show
* the thing it was being paid to run.
*
* @param {number} liveAccountCount how many real-money accounts the report shows,
*   so every simulated count can be printed against its denominator.
* @returns {null|object} null when there is nothing simulated and nothing
*   undetermined — absence of a section, not a section full of zeros.
*/
function buildSimulationSection(client, dailyImport, liveAccountCount = 0) {
	const sim = dailyImport?.simulation;
	const simSnapshots = sim?.snapshots || [];
	const undeterminedSnapshots = sim?.undetermined?.snapshots || [];
	if (!simSnapshots.length && !undeterminedSnapshots.length) return null;
	const registry = {
		...dailyImport?.accounts || {},
		...client?.accountRegistry || {}
	};
	const rowsFor = (snapshots, nature) => snapshots.map((snapshot) => {
		const meta = ciLookup(registry, snapshot.accountName) || {};
		const classification = classifyAccountNature(meta, { accountName: snapshot.accountName });
		const strategies = (snapshot.strategies || []).filter((strategy) => strategy.enabled);
		return {
			...snapshot,
			meta,
			nature,
			natureReason: classification.reason,
			natureSource: classification.source,
			heuristic: classification.heuristic,
			enabledStrategies: strategies.map((strategy) => strategy.strategyName || strategy.strategyFamily || "Strategy")
		};
	});
	const simRows = rowsFor(simSnapshots, ACCOUNT_NATURES.SIMULATION);
	const undeterminedRows = rowsFor(undeterminedSnapshots, ACCOUNT_NATURES.UNDETERMINED);
	const orders = (sim?.orders || []).length;
	const executions = (sim?.executions || []).length;
	const enabledStrategies = (sim?.strategies || []).filter((strategy) => strategy.enabled).length;
	return {
		label: simRows.length ? "Simulation (not real money)" : "Accounts not included in the figures above",
		note: simRows.length ? "These accounts trade simulated funds. Their balances and results are shown separately and are not included in any figure above." : "These accounts could not be identified as either real money or simulated funds, so they are left out of every figure above. They are not being reported as simulated either.",
		hasSimulation: simRows.length > 0,
		accounts: simRows,
		totals: summarizeAccountRows(simRows).totals,
		counts: {
			accounts: simRows.length,
			ofAccountsReported: simRows.length + undeterminedRows.length + liveAccountCount,
			liveAccounts: liveAccountCount,
			orders,
			executions,
			enabledStrategies,
			traded: orders > 0 || executions > 0
		},
		undetermined: undeterminedRows.length ? {
			label: "Nature undetermined - counted as neither",
			accounts: undeterminedRows,
			totals: summarizeAccountRows(undeterminedRows).totals,
			counts: { accounts: undeterminedRows.length }
		} : null
	};
}
function buildDailyReportSummary(client, dailyImport) {
	const snapshots = dailyImport?.snapshots || [];
	const registry = {
		...dailyImport?.accounts || {},
		...client?.accountRegistry || {}
	};
	const grouped = {
		evaluations: [],
		funded: [],
		cash: [],
		cashIra: [],
		cashStraight: [],
		cashLegacy: [],
		unclassified: [],
		pendingClassification: [],
		ignored: [],
		retired: []
	};
	const closeDate = String(dailyImport?.date || "").slice(0, 10);
	const breachedOnThisClose = new Set((dailyImport?.flags || []).filter((flag) => flag.type === "Drawdown breached").map((flag) => String(flag.accountName || "").toLowerCase()).filter(Boolean));
	for (const snapshot of snapshots) {
		const meta = ciLookup(registry, snapshot.accountName) || {};
		const row = {
			...snapshot,
			meta
		};
		const failedOn = String(meta.dateFailed || "").slice(0, 10);
		const diedToday = failedOn && failedOn === closeDate || breachedOnThisClose.has(String(snapshot.accountName || "").toLowerCase());
		if (meta.status === ACCOUNT_STATUSES.FAILED && !diedToday) {
			grouped.retired.push(row);
			continue;
		}
		if (isCashType(meta.accountType)) {
			grouped.cash.push(row);
			if (meta.accountType === ACCOUNT_TYPES.CASH_IRA) grouped.cashIra.push(row);
			else if (meta.accountType === ACCOUNT_TYPES.CASH_STRAIGHT) grouped.cashStraight.push(row);
			else grouped.cashLegacy.push(row);
		} else if (meta.accountType === "Funded") grouped.funded.push(row);
		else if (meta.accountType === "Inactive / Ignore") grouped.ignored.push(row);
		else if (meta.accountType?.startsWith("Evaluation")) grouped.evaluations.push(row);
		else if (meta.accountType === ACCOUNT_TYPES.PENDING_CLASSIFICATION) grouped.pendingClassification.push(row);
		else grouped.unclassified.push(row);
	}
	const allVisible = [
		...grouped.evaluations,
		...grouped.funded,
		...grouped.cash,
		...grouped.unclassified,
		...grouped.pendingClassification
	];
	const { totals } = summarizeAccountRows([
		...grouped.funded,
		...grouped.cash,
		...grouped.unclassified
	]);
	const evaluationTotals = summarizeAccountRows(grouped.evaluations).totals;
	const pendingClassificationTotals = summarizeAccountRows(grouped.pendingClassification).totals;
	const simulation = buildSimulationSection(client, dailyImport, snapshots.length);
	const evaluations = buildEvaluationSection(client, dailyImport, {
		rows: grouped.evaluations,
		totals: evaluationTotals,
		reportedAccountCount: snapshots.length
	});
	const openFlags = (dailyImport?.flags || []).filter((f) => f.status !== "Resolved" && f.status !== "Acknowledged");
	const criticalFlags = openFlags.filter((f) => f.severity === "Critical");
	const imports = client?.dailyImports || [];
	const currentIdx = imports.findIndex((d) => d.date === dailyImport?.date);
	const priorImport = currentIdx > 0 ? imports[currentIdx - 1] : null;
	const priorDailyPnl = priorImport ? (priorImport.snapshots || []).reduce((s, snap) => s + Number(snap.grossRealizedPnl || 0), 0) : null;
	return {
		clientName: client?.name || "Client",
		camName: "",
		date: dailyImport?.date || "",
		status: dailyImport?.status || "No data",
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		grouped,
		totals,
		segments: buildClientSegments(client, dailyImport),
		evaluationTotals,
		evaluations,
		pendingClassificationTotals,
		simulation,
		priorDailyPnl,
		flags: dailyImport?.flags || [],
		openFlags,
		criticalFlags,
		counts: {
			accounts: allVisible.length,
			evaluations: grouped.evaluations.length,
			funded: grouped.funded.length,
			cash: grouped.cash.length,
			cashIra: grouped.cashIra.length,
			cashStraight: grouped.cashStraight.length,
			openFlags: openFlags.length,
			criticalFlags: criticalFlags.length,
			retired: grouped.retired.length
		}
	};
}
//#endregion
//#region src/offline/renderOfflineReport.js
var MONEY = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD"
});
function money(value) {
	const n = Number(value);
	return Number.isFinite(n) ? MONEY.format(n) : "—";
}
function esc(value) {
	return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function sign(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n === 0) return "";
	return n > 0 ? " pos" : " neg";
}
function strategyLine(strategies = []) {
	if (!strategies.length) return "";
	return `<tr class="sub-row"><td colspan="4">${strategies.map((s) => {
		return esc(`${[s.strategyFamily, s.strategyVersion].filter(Boolean).join(" ") || s.strategyName || "unnamed"}${s.instrument ? ` on ${s.instrument}` : ""}${s.ran === false ? " (did not run)" : ""}`);
	}).join(" &middot; ")}</td></tr>`;
}
function rows(list = []) {
	if (!list.length) return "";
	return list.map((row) => `
      <tr>
        <td>${esc(row.alias || row.accountName)}</td>
        <td class="num${sign(row.grossRealizedPnl)}">${money(row.grossRealizedPnl)}</td>
        <td class="num${sign(row.weeklyPnl)}">${money(row.weeklyPnl)}</td>
        <td class="num">${money(row.accountBalance)}</td>
      </tr>${strategyLine(row.strategies)}`).join("");
}
function section(title, list, totals, note = "") {
	if (!list?.length) return "";
	return `
    <section>
      <h2>${esc(title)}</h2>
      ${note ? `<p class="note">${esc(note)}</p>` : ""}
      <table>
        <thead><tr><th>Account</th><th class="num">Day</th><th class="num">Week</th><th class="num">Balance</th></tr></thead>
        <tbody>${rows(list)}</tbody>
        ${totals ? `<tfoot><tr>
          <th>Subtotal</th>
          <th class="num${sign(totals.grossRealizedPnl)}">${money(totals.grossRealizedPnl)}</th>
          <th class="num${sign(totals.weeklyPnl)}">${money(totals.weeklyPnl)}</th>
          <th class="num">${money(totals.aggregateBalance)}</th>
        </tr></tfoot>` : ""}
      </table>
    </section>`;
}
var STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; color: #17202a; background: #fff; }
  .sheet { max-width: 820px; margin: 0 auto; }
  header { border-bottom: 2px solid #17202a; padding-bottom: 14px; margin-bottom: 22px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .sub { color: #5a6673; font-size: 13px; }
  .headline { display: flex; gap: 28px; flex-wrap: wrap; margin: 22px 0 26px; }
  .tile { min-width: 150px; }
  .tile .label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #5a6673; }
  .tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .pos { color: #0f7a3d; } .neg { color: #b3261e; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e3e7ea; }
  th { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #5a6673; font-weight: 600; }
  tfoot th { border-top: 2px solid #17202a; border-bottom: none; font-size: 13px; text-transform: none; color: #17202a; }
  .num { text-align: right; }
  .note { font-size: 12px; color: #5a6673; margin: 0 0 8px; }
  .sub-row td { padding-top: 0; padding-bottom: 9px; border-bottom: 1px solid #e3e7ea;
                font-size: 11.5px; color: #5a6673; }
  tbody tr:not(.sub-row) td { border-bottom: none; }
  .warnings { border: 1px solid #e0b000; background: #fff8e1; border-radius: 6px; padding: 12px 16px; margin: 0 0 22px; }
  .warnings h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: #7a5c00; }
  .warnings ul { margin: 0; padding-left: 18px; }
  .warnings li { font-size: 13px; margin: 3px 0; }
  footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e3e7ea; font-size: 11px; color: #5a6673; }
  /* THE BAR IS CHROME, NOT DOCUMENT. Same contract as the CRM's report sheet:
     .report-actions carries .no-print there (src/index.css), so none of it
     reaches a client's PDF. */
  .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
             background: #eff5f9; border: 1px solid #ccd9e3; border-radius: 6px;
             padding: 10px 12px; margin: 0 0 22px; }
  .actions button { font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 5px;
                    border: 1px solid #ccd9e3; background: #fff; color: #12202b; cursor: pointer; }
  .actions button.primary { background: #1257c3; border-color: #1257c3; color: #fff; font-weight: 600; }
  .actions button:hover { border-color: #1257c3; }
  .actions .hint { font-size: 12px; color: #556675; }
  .actions textarea { width: 100%; min-height: 96px; font: 12px/1.5 ui-monospace, Consolas, monospace;
                      border: 1px solid #ccd9e3; border-radius: 5px; padding: 8px; }
  /* 12mm is what src/index.css sets for the CRM's report, so a page printed
     here and a page downloaded from the CRM have the same margin. */
  @page { margin: 12mm; }
  @media print {
    body { padding: 0; }
    .sheet { max-width: none; }
    section { break-inside: avoid; }
    .no-print { display: none !important; }
  }
`;
/**
* The sentence the document carries about itself.
*
* A report generated on the machine is not the desk's record. It is built from
* one machine's captured day, with the last account classification the CRM was
* able to send, and it says so where the reader cannot miss it.
*/
var PROVENANCE = "Generated on the trading machine from its own captured close, without the CRM. Account classification comes from the last roster the CRM was able to send to this machine.";
var PROVENANCE_FROM_CRM = "Generated from the desk record at the close. Account classification is the registry as it stood when this was built.";
function summaryText(built) {
	const { client, dailyImport, warnings = [] } = built || {};
	if (!client || !dailyImport) return "";
	const message = buildClientMessageReport(client, dailyImport);
	if (!warnings.length) return message;
	return [
		message,
		"",
		...warnings.map((warning) => `_${warning}_`)
	].join("\n");
}
var COPY_SCRIPT = `
  (function () {
    var button = document.getElementById('copy-summary');
    var box = document.getElementById('summary-box');
    if (!button || !box) return;
    button.addEventListener('click', function () {
      var text = box.value;
      var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy summary'; }, 2000); };
      var manual = function () { box.hidden = false; box.focus(); box.select(); button.textContent = 'Copy it from here'; };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, manual);
          return;
        }
      } catch (error) { /* falls through to manual */ }
      manual();
    });
  })();
`;
function renderOfflineReport(built) {
	const { report, warnings = [], metadata, provenance = PROVENANCE } = built || {};
	if (!report) throw new Error("There is no report to render.");
	const g = report.grouped || {};
	const title = `${report.clientName} - ${report.date} daily report`;
	const tiles = [
		[
			"Accounts",
			String((report.grouped?.funded?.length || 0) + (report.grouped?.cash?.length || 0) + (report.grouped?.unclassified?.length || 0)),
			""
		],
		[
			"Daily realized",
			money(report.totals?.grossRealizedPnl),
			sign(report.totals?.grossRealizedPnl)
		],
		[
			"Weekly",
			money(report.totals?.weeklyPnl),
			sign(report.totals?.weeklyPnl)
		]
	].map(([label, value, cls]) => `
      <div class="tile"><div class="label">${esc(label)}</div><div class="value${cls}">${esc(value)}</div></div>`).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><div class="sheet">
  <header>
    <h1>${esc(report.clientName)}</h1>
    <div class="sub">Daily close report &middot; ${esc(report.date)}</div>
  </header>

  <div class="actions no-print">
    <button type="button" class="primary" onclick="window.print()">Save as PDF</button>
    <button type="button" id="copy-summary">Copy summary</button>
    <span class="hint">Send the PDF. This .html file also carries the raw capture behind the page.</span>
    <textarea id="summary-box" readonly hidden>${esc(summaryText(built))}</textarea>
  </div>

  <div class="headline">${tiles}</div>

  ${warnings.length ? `<div class="warnings"><h3>Read before sending</h3><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}

  ${section("Funded", g.funded, null)}
  ${section("Cash", g.cash, null)}
  ${section("Unclassified", g.unclassified, null, "Real money whose pool has not been named yet. Counted in the total above.")}
  ${section("Evaluations", g.evaluations, report.evaluationTotals, "Challenge capital, not the client’s money. Shown here and never in the total above.")}
  ${section("Not classified on this machine", g.pendingClassification, report.pendingClassificationTotals, "These accounts are not in the roster this machine holds, so they could not be classified and are not in the total above.")}

  <footer>
    ${esc(provenance)}
    ${metadata?.capturedAt ? `<br />Capture taken ${esc(metadata.capturedAt)}.` : ""}
  </footer>
</div>
<script>${COPY_SCRIPT}<\/script>
</body></html>`;
}
//#endregion
//#region src/domain/dailyReportPackage.js
/** A client is in the package when it has a close on that date. */
function clientsWithCloseOn(clients, date) {
	const day = String(date || "").trim();
	if (!day) return [];
	return (clients || []).map((client) => ({
		client,
		dailyImport: (client?.dailyImports || []).find((entry) => entry?.date === day) || null
	})).filter((entry) => entry.dailyImport);
}
//#endregion
//#region src/domain/dailyEmailPackage.js
/** The subject a CAM sees in their phone's notification, so it leads with the day. */
function subjectFor$1(date, clientCount) {
	return `Daily reports · ${date} · ${`${clientCount} client${clientCount === 1 ? "" : "s"}`}`;
}
function packageFileNames(date) {
	return {
		reports: `reports-${date}.zip`,
		raw: `raw-${date}.json`
	};
}
function rawAccount(snapshot) {
	return {
		accountName: snapshot.accountName ?? null,
		alias: snapshot.meta?.alias ?? null,
		accountType: snapshot.meta?.accountType ?? null,
		status: snapshot.meta?.status ?? null,
		grossRealizedPnl: numberOrNull(snapshot.grossRealizedPnl),
		weeklyPnl: numberOrNull(snapshot.weeklyPnl),
		unrealizedPnl: numberOrNull(snapshot.unrealizedPnl),
		accountBalance: numberOrNull(snapshot.accountBalance),
		trailingMaxDrawdown: numberOrNull(snapshot.trailingMaxDrawdown),
		strategies: (snapshot.strategies || []).map((strategy) => ({
			strategyFamily: strategy.strategyFamily ?? null,
			strategyVersion: strategy.strategyVersion ?? null,
			strategyName: strategy.strategyName ?? null,
			instrument: strategy.instrument ?? null,
			ran: strategyRan(strategy),
			realized: numberOrNull(strategy.realized)
		}))
	};
}
function numberOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}
function buildRawExport({ entries, date, generatedAt }) {
	return {
		date,
		generatedAt: generatedAt ?? null,
		source: "Vincere CRM desk record",
		redaction: "Strategy parameters are not included: they carry the desk licence key and the algorithm tuning. Use Deep Export on the machine for the full record.",
		clients: entries.map(({ client, dailyImport }) => ({
			client: client?.name || "Client",
			accounts: (dailyImport?.snapshots || []).map(rawAccount)
		}))
	};
}
/**
* Everything one email carries, built from the desk record alone.
*
* @param clients      the CAM's book.
* @param date         'YYYY-MM-DD'.
* @param generatedAt  ISO stamp, passed in rather than read, so a test can
*                     assert the whole payload byte for byte.
* @param camName      shown in the body so a forwarded email says whose it is.
*/
function buildDailyEmailPackage({ clients, date, generatedAt = null, camName = "" }) {
	const entries = clientsWithCloseOn(clients, date);
	const built = [];
	const failed = [];
	for (const entry of entries) try {
		const report = buildDailyReportSummary(entry.client, entry.dailyImport);
		const html = renderOfflineReport({
			report,
			client: entry.client,
			dailyImport: entry.dailyImport,
			warnings: [],
			metadata: null,
			provenance: PROVENANCE_FROM_CRM
		});
		built.push({
			...entry,
			report,
			html
		});
	} catch (error) {
		failed.push({
			client: entry.client?.name || "Client",
			reason: error?.message || "could not be built"
		});
	}
	const attachments = [];
	const attachmentNames = packageFileNames(date);
	if (built.length) {
		const files = {};
		const names = entryNames(built, date);
		for (const [index, item] of built.entries()) files[`${names[index]}.html`] = strToU8(item.html);
		if (Object.keys(files).length !== built.length) throw new Error(`The report package would have lost ${built.length - Object.keys(files).length} of ${built.length} reports to a file name collision.`);
		attachments.push({
			name: attachmentNames.reports,
			bytes: zipSync(files, { level: 6 })
		});
	}
	const raw = buildRawExport({
		entries: built,
		date,
		generatedAt
	});
	attachments.push({
		name: attachmentNames.raw,
		bytes: strToU8(`${JSON.stringify(raw, null, 2)}\n`)
	});
	return {
		subject: subjectFor$1(date, built.length),
		text: bodyFor({
			built,
			failed,
			date,
			camName
		}),
		attachments,
		built: built.map((item) => item.client?.name || "Client"),
		failed
	};
}
function bodyFor({ built, failed = [], date, camName = "" }) {
	const lines = [];
	lines.push(`Daily reports · ${date}${camName ? ` · ${camName}` : ""}`);
	lines.push("");
	if (!built.length) {
		lines.push("No client has a close for this date.");
		return lines.join("\n");
	}
	for (const item of built) {
		lines.push(buildClientMessageReport(item.client, item.dailyImport));
		lines.push("");
		lines.push("—".repeat(3));
		lines.push("");
	}
	if (failed.length) {
		lines.push(`Not built (${failed.length}):`);
		for (const failure of failed) lines.push(`  • ${failure.client}: ${failure.reason}`);
		lines.push("");
	}
	lines.push("The same reports are attached as HTML, one file per client.");
	lines.push("Open one and print it if a client asks for a PDF.");
	return lines.join("\n");
}
function fileStem$1(clientName, date) {
	return `${String(clientName || "Client").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Client"} - ${date} daily report`;
}
function entryNames(built, date) {
	const counts = /* @__PURE__ */ new Map();
	for (const item of built) {
		const stem = fileStem$1(item.client?.name, date);
		counts.set(stem, (counts.get(stem) || 0) + 1);
	}
	return built.map((item) => {
		const stem = fileStem$1(item.client?.name, date);
		if ((counts.get(stem) || 0) < 2) return stem;
		const id = String(item.client?.id || "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 8);
		return id ? `${stem} (${id})` : stem;
	});
}
//#endregion
//#region src/domain/dailyEmailPlan.js
var lower = (value) => String(value ?? "").trim().toLowerCase();
/**
* @param camProfiles  from buildCrmStateFromTables: { id, name, status, clientIds }.
* @param users        app_users rows shaped { email, name, camProfileId, status }.
* @param clients      the whole book.
* @returns {{ deliveries: Array, unreachable: Array }}
*/
function planDailyEmails({ clients = [], camProfiles = [], users = [] }) {
	const clientById = /* @__PURE__ */ new Map();
	for (const client of clients) if (client?.id) clientById.set(String(client.id), client);
	const usersByProfile = /* @__PURE__ */ new Map();
	for (const user of users) {
		if (!user?.email || !user?.camProfileId) continue;
		if (lower(user.status) === "inactive" || lower(user.status) === "disabled") continue;
		const key = String(user.camProfileId);
		if (!usersByProfile.has(key)) usersByProfile.set(key, []);
		usersByProfile.get(key).push(user);
	}
	const deliveries = [];
	const unreachable = [];
	for (const profile of camProfiles) {
		if (lower(profile?.status) === "inactive") continue;
		const book = (profile?.clientIds || []).map((id) => clientById.get(String(id))).filter(Boolean);
		if (!book.length) continue;
		const recipients = usersByProfile.get(String(profile.id)) || [];
		if (!recipients.length) {
			unreachable.push({
				camProfileId: profile.id,
				camName: profile.name || "",
				clients: book.length
			});
			continue;
		}
		deliveries.push({
			camProfileId: profile.id,
			camName: profile.name || "",
			to: recipients.map((user) => ({
				email: user.email,
				name: user.name || profile.name || ""
			})),
			clients: book
		});
	}
	return {
		deliveries,
		unreachable
	};
}
/**
* The plan with each delivery's message already built.
*
* Kept apart from planDailyEmails so the split of the book can be asserted
* without building 62 reports, and so a failure to build one CAM's package
* names that CAM instead of ending the run.
*/
function buildDailyEmailRun({ clients, camProfiles, users, date, generatedAt = null }) {
	const { deliveries, unreachable } = planDailyEmails({
		clients,
		camProfiles,
		users
	});
	const messages = [];
	const failed = [];
	for (const delivery of deliveries) try {
		const built = buildDailyEmailPackage({
			clients: delivery.clients,
			date,
			generatedAt,
			camName: delivery.camName
		});
		if (!built.built.length) continue;
		messages.push({
			...delivery,
			...built
		});
	} catch (error) {
		failed.push({
			camName: delivery.camName,
			reason: error?.message || "could not be built"
		});
	}
	return {
		messages,
		unreachable,
		failed
	};
}
//#endregion
//#region src/domain/dailyEmailJob.js
function usersFromRows(rows = [], camProfileRows = []) {
	const legacyByUuid = /* @__PURE__ */ new Map();
	for (const profile of camProfileRows) if (profile?.id) legacyByUuid.set(String(profile.id), profile.legacy_key || profile.id);
	return rows.map((row) => {
		const raw = row.cam_profile_id ? String(row.cam_profile_id) : "";
		return {
			email: row.email || "",
			name: row.display_name || row.username || "",
			camProfileId: raw ? legacyByUuid.get(raw) || raw : null,
			status: row.status || "Active"
		};
	}).filter((user) => user.email && user.camProfileId);
}
/**
* @param tables       the rows for the date, shaped as buildCrmStateFromTables wants.
* @param userRows     app_users rows.
* @param date         'YYYY-MM-DD'.
* @param send         ({ to, subject, text, attachments }) => Promise. Injected.
* @param generatedAt  ISO stamp, passed in so a run is reproducible.
*/
async function runDailyEmails({ tables, userRows = [], date, send, generatedAt = null }) {
	const state = buildCrmStateFromTables(tables || {});
	const run = buildDailyEmailRun({
		clients: state.clients || [],
		camProfiles: state.camProfiles || [],
		users: usersFromRows(userRows, (tables || {}).cam_profiles || []),
		date,
		generatedAt
	});
	const sent = [];
	const refused = [];
	for (const message of run.messages) try {
		const result = await send({
			to: message.to,
			subject: message.subject,
			text: message.text,
			attachments: message.attachments
		});
		sent.push({
			camName: message.camName,
			to: message.to.map((entry) => entry.email),
			clients: message.built.length,
			messageId: result?.messageId || null
		});
	} catch (error) {
		refused.push({
			camName: message.camName,
			to: message.to.map((entry) => entry.email),
			reason: error?.message || "the provider refused the message"
		});
	}
	return {
		date,
		sent,
		refused,
		unreachable: run.unreachable,
		notBuilt: run.failed,
		ok: refused.length === 0 && run.failed.length === 0
	};
}
//#endregion
//#region src/domain/emailDelivery.js
/** Brevo's own ceiling for one message. Ours measured 0.4 MB; this catches a book that grew. */
var MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
var EmailDeliveryError = class extends Error {
	constructor(message, { status = 0, cause } = {}) {
		super(message, cause ? { cause } : void 0);
		this.name = "EmailDeliveryError";
		this.status = status;
	}
};
function toBase64(bytes) {
	if (typeof bytes === "string") return toBase64(new TextEncoder().encode(bytes));
	let binary = "";
	const chunk = 32768;
	for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	return btoa(binary);
}
function brevoPayload({ from, to, subject, text, attachments = [] }) {
	if (!from?.email) throw new EmailDeliveryError("A verified sender address is required.");
	const recipients = (Array.isArray(to) ? to : [to]).filter((entry) => entry?.email);
	if (!recipients.length) throw new EmailDeliveryError("No recipient has an email address.");
	const total = attachments.reduce((sum, item) => sum + (item.bytes?.length || 0), 0);
	if (total > 10485760) throw new EmailDeliveryError(`The attachments are ${(total / 1024 / 1024).toFixed(1)} MB, over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB a message may carry.`);
	const payload = {
		sender: {
			email: from.email,
			...from.name ? { name: from.name } : {}
		},
		to: recipients.map((entry) => ({
			email: entry.email,
			...entry.name ? { name: entry.name } : {}
		})),
		subject,
		textContent: text
	};
	if (attachments.length) payload.attachment = attachments.map((item) => ({
		name: item.name,
		content: toBase64(item.bytes)
	}));
	return payload;
}
/**
* Send one message. Resolves with the provider's message id, throws otherwise.
*
* @param fetchImpl injected so the tests assert the request that would go out
*                  without one going out.
*/
async function sendViaBrevo({ apiKey, from, to, subject, text, attachments = [] }, fetchImpl = globalThis.fetch) {
	if (!apiKey) throw new EmailDeliveryError("No email provider key is configured, so nothing was sent.");
	const payload = brevoPayload({
		from,
		to,
		subject,
		text,
		attachments
	});
	let response;
	try {
		response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
			method: "POST",
			headers: {
				"api-key": apiKey,
				"content-type": "application/json",
				accept: "application/json"
			},
			body: JSON.stringify(payload)
		});
	} catch (error) {
		throw new EmailDeliveryError("The email provider could not be reached.", { cause: error });
	}
	if (!response.ok) {
		let detail = "";
		try {
			const body = await response.json();
			detail = body?.message || body?.code || "";
		} catch {}
		throw new EmailDeliveryError(`The email was refused (${response.status})${detail ? `: ${detail}` : ""}.`, { status: response.status });
	}
	try {
		return { messageId: (await response.json())?.messageId || null };
	} catch {
		return { messageId: null };
	}
}
//#endregion
//#region src/offline/captureRedaction.js
var isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/**
* A copy of the capture with every strategy's configuration emptied.
*
* Returns a new object; the input is not touched, because a caller that goes on
* to upload the same capture must upload what the machine actually reported.
*/
function redactCapture(capture) {
	if (Array.isArray(capture)) return capture.map(redactCapture);
	if (!isPlainObject(capture)) return capture;
	const isStrategyRow = capture.parameterCaptureStatus !== void 0 || capture.parameters !== void 0;
	const out = {};
	for (const [key, value] of Object.entries(capture)) {
		if (isStrategyRow && key === "parametersRaw") continue;
		if (isStrategyRow && (key === "parameters" || key === "extraValues") && isPlainObject(value)) {
			out[key] = {};
			continue;
		}
		out[key] = redactCapture(value);
	}
	return out;
}
Object.freeze([
	"parameters",
	"parametersRaw",
	"extraValues"
]);
//#endregion
//#region src/domain/openPositions.js
function numeric(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
/**
* Accounts that still had something open when the snapshot was taken.
*
* Unrealized PnL is the signal because it is the one every account carries and
* the one that moves into realized when the position closes. A position at
* exactly break even is invisible here, and that is acceptable: it moves no
* money into the realized total, which is the number being protected.
*/
function accountsWithOpenPositions(accounts) {
	return (accounts || []).filter((account) => numeric(account?.unrealizedPnl) !== 0).map((account) => ({
		accountName: account.accountName,
		unrealizedPnl: numeric(account.unrealizedPnl)
	}));
}
/**
* Was this snapshot taken before the day had finished closing?
*
* @returns {{ open: boolean, accounts: Array, unrealizedTotal: number }}
*/
function openPositionsAt(snapshot) {
	const accounts = accountsWithOpenPositions(snapshot?.accounts);
	return {
		open: accounts.length > 0,
		accounts,
		unrealizedTotal: Number(accounts.reduce((sum, a) => sum + a.unrealizedPnl, 0).toFixed(2))
	};
}
//#endregion
//#region src/domain/autoExportContract.js
var ROW_SCHEMAS = {
	accounts: {
		required: ["accountName"],
		strings: [
			"connectionName",
			"displayName",
			"currency",
			"status"
		],
		numbers: [
			"netLiquidation",
			"cashValue",
			"realizedPnl",
			"grossRealizedPnl",
			"unrealizedPnl",
			"totalPnl",
			"weeklyPnl",
			"trailingMaxDrawdown",
			"buyingPower",
			"excessIntradayMargin",
			"initialMargin",
			"maintenanceMargin"
		],
		optionalBooleans: ["isSimulated"]
	},
	strategies: {
		required: [
			"strategyId",
			"strategyName",
			"accountName",
			"instrument",
			"state",
			"parameterCaptureStatus"
		],
		strings: [
			"strategyDisplayName",
			"position",
			"dataSeries",
			"connectionName",
			"parameterCaptureStatus"
		],
		numbers: [
			"quantity",
			"averagePrice",
			"realizedPnl",
			"unrealizedPnl"
		],
		booleans: ["enabled", "sync"],
		timestamps: ["startedAt"],
		objects: ["parameters"]
	},
	orders: {
		required: [
			"orderId",
			"accountName",
			"instrument",
			"action",
			"orderType",
			"state"
		],
		strings: [
			"strategyId",
			"strategyName",
			"action",
			"orderType",
			"state",
			"tif",
			"oco",
			"name",
			"nativeId"
		],
		numbers: [
			"quantity",
			"filled",
			"remaining",
			"limitPrice",
			"stopPrice",
			"averageFillPrice"
		],
		timestamps: ["time"]
	},
	executions: {
		required: [
			"executionId",
			"accountName",
			"instrument",
			"action",
			"time"
		],
		strings: [
			"orderId",
			"strategyId",
			"strategyName",
			"instrument",
			"action",
			"marketPosition",
			"entryExit",
			"name",
			"connectionName",
			"nativeId"
		],
		numbers: [
			"quantity",
			"price",
			"commission",
			"fee",
			"rate",
			"realizedPnl"
		],
		timestamps: ["time"]
	}
};
var ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
function hasOwn(object, key) {
	return Object.prototype.hasOwnProperty.call(object, key);
}
function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isIsoTimestamp(value) {
	if (typeof value !== "string") return false;
	return ISO_TIMESTAMP.test(value) && isDate(value.slice(0, 10));
}
function isDate(value) {
	if (typeof value !== "string" || !DATE.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function tradingDateInNewYork(timestamp) {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(date);
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
	return `${values.year}-${values.month}-${values.day}`;
}
function isScalarOrNull(value) {
	return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
}
function validateRows(snapshot, section, errors) {
	const rows = snapshot[section];
	if (!Array.isArray(rows)) {
		errors.push(`${section} must be an array`);
		return;
	}
	const schema = ROW_SCHEMAS[section];
	rows.forEach((row, index) => {
		const path = `${section}[${index}]`;
		if (!isObject(row)) {
			errors.push(`${path} must be an object`);
			return;
		}
		for (const key of schema.required) if (!hasOwn(row, key) || typeof row[key] !== "string" || !row[key].trim()) errors.push(`${path}.${key} is required`);
		for (const key of schema.strings || []) if (hasOwn(row, key) && row[key] !== null && typeof row[key] !== "string") errors.push(`${path}.${key} must be a string or null`);
		for (const key of schema.numbers || []) if (!hasOwn(row, key) || row[key] !== null && (typeof row[key] !== "number" || !Number.isFinite(row[key]))) errors.push(`${path}.${key} must be a number or null`);
		for (const key of schema.booleans || []) if (!hasOwn(row, key) || row[key] !== null && typeof row[key] !== "boolean") errors.push(`${path}.${key} must be a boolean or null`);
		for (const key of schema.optionalBooleans || []) if (hasOwn(row, key) && row[key] !== null && typeof row[key] !== "boolean") errors.push(`${path}.${key} must be a boolean or null when present`);
		for (const key of schema.timestamps || []) if (!hasOwn(row, key) || row[key] !== null && !isIsoTimestamp(row[key])) errors.push(`${path}.${key} must be an ISO-8601 timestamp with an offset or null`);
		for (const key of schema.objects || []) if (!hasOwn(row, key) || !isObject(row[key])) errors.push(`${path}.${key} must be an object`);
		else for (const [parameter, value] of Object.entries(row[key])) if (!isScalarOrNull(value)) errors.push(`${path}.${key}.${parameter} must be a scalar or null`);
	});
}
function validateAutoExportSnapshot(snapshot) {
	const errors = [];
	if (!isObject(snapshot)) return {
		ok: false,
		errors: ["snapshot must be an object"]
	};
	if (snapshot.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	for (const key of ["captureId", "timeZone"]) if (typeof snapshot[key] !== "string" || !snapshot[key].trim()) errors.push(`${key} is required`);
	if (!isIsoTimestamp(snapshot.capturedAt)) errors.push("capturedAt must be an ISO-8601 timestamp with an offset");
	if (!isDate(snapshot.tradingDate)) errors.push("tradingDate must be an ISO date");
	if (snapshot.timeZone !== "America/New_York") errors.push("timeZone must be America/New_York");
	if (isIsoTimestamp(snapshot.capturedAt) && isDate(snapshot.tradingDate) && tradingDateInNewYork(snapshot.capturedAt) !== snapshot.tradingDate) errors.push("tradingDate must match capturedAt in America/New_York");
	if (!isObject(snapshot.source)) errors.push("source must be an object");
	else for (const key of [
		"machineId",
		"agentVersion",
		"addonVersion",
		"ninjaTraderVersion"
	]) if (typeof snapshot.source[key] !== "string" || !snapshot.source[key].trim()) errors.push(`source.${key} is required`);
	for (const section of Object.keys(ROW_SCHEMAS)) validateRows(snapshot, section, errors);
	return {
		ok: errors.length === 0,
		errors
	};
}
//#endregion
//#region src/domain/autoImport.js
var SECTION_NAMES = [
	"accounts",
	"strategies",
	"orders",
	"executions"
];
var AutoImportValidationError = class extends Error {
	constructor(code, errors) {
		super(errors.join("; ") || code);
		this.name = "AutoImportValidationError";
		this.code = code;
		this.errors = errors;
	}
};
function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}
function normalizeDirection(value) {
	const text = trimText(value);
	if (/^(long|short|both)$/i.test(text)) return `${text[0].toUpperCase()}${text.slice(1).toLowerCase()}`;
	return text;
}
function parseParamNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function numberList(values) {
	return values.map(parseParamNumber).filter((value) => value != null);
}
function stableJson(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}
function mapParameters(parameters) {
	const valuesByName = { ...parameters };
	return {
		parsed: true,
		valuesByName,
		direction: normalizeDirection(valuesByName.MyTradeDirection),
		posSizes: numberList([
			valuesByName.PosSize1,
			valuesByName.PosSize2,
			valuesByName.PosSize3,
			valuesByName.PositionSize
		]),
		profitTargets: numberList([
			valuesByName.ProfitTargetTicks1,
			valuesByName.ProfitTargetTicks2,
			valuesByName.ProfitTargetTicks3,
			valuesByName.ProfitTargetTicks
		]),
		stopLossTicks: parseParamNumber(valuesByName.StopLossTicks),
		tradeWindow: [valuesByName.TradeStartTime || valuesByName.TradeStart1 || "", valuesByName.TradeEndTime || valuesByName.TradeEnd1 || ""]
	};
}
function selectDailyPnl({ realizedPnl, grossRealizedPnl }) {
	if (realizedPnl === null) {
		if (grossRealizedPnl === null) return {
			value: null,
			source: "unavailable"
		};
		return {
			value: grossRealizedPnl,
			source: "gross_missing_realized"
		};
	}
	if (realizedPnl !== 0) return {
		value: realizedPnl,
		source: "realized"
	};
	if (grossRealizedPnl !== null && grossRealizedPnl !== 0) return {
		value: grossRealizedPnl,
		source: "gross_fallback"
	};
	return {
		value: 0,
		source: "realized"
	};
}
function duplicateErrors(snapshot) {
	const errors = [];
	const duplicateBy = (section, field, comparable = (value) => value) => {
		const firstIndex = /* @__PURE__ */ new Map();
		snapshot[section].forEach((row, index) => {
			const key = comparable(trimText(row[field]));
			if (firstIndex.has(key)) errors.push(`${section}[${index}].${field} duplicates ${section}[${firstIndex.get(key)}].${field}`);
			else firstIndex.set(key, index);
		});
	};
	duplicateBy("accounts", "accountName", (value) => value.toLowerCase());
	duplicateBy("strategies", "strategyId");
	duplicateBy("orders", "orderId");
	duplicateBy("executions", "executionId");
	return errors;
}
var REFERENCE_ERROR_ROW_SAMPLE = 3;
function accountReferenceErrors(snapshot) {
	const accountsByLower = new Set(snapshot.accounts.map((account) => trimText(account.accountName).toLowerCase()));
	const errors = [];
	for (const section of [
		"strategies",
		"orders",
		"executions"
	]) {
		const offending = /* @__PURE__ */ new Map();
		snapshot[section].forEach((row, index) => {
			const name = trimText(row.accountName);
			if (accountsByLower.has(name.toLowerCase())) return;
			if (!offending.has(name)) offending.set(name, []);
			offending.get(name).push(index);
		});
		for (const [name, indexes] of offending) {
			const shown = indexes.slice(0, REFERENCE_ERROR_ROW_SAMPLE).join(", ");
			const more = indexes.length > REFERENCE_ERROR_ROW_SAMPLE ? ` and ${indexes.length - REFERENCE_ERROR_ROW_SAMPLE} more` : "";
			errors.push(`${section}[${shown}]${more}.accountName does not reference an account (${name === "" ? "blank" : name})`);
		}
	}
	return errors;
}
function canonicalAccountName(accountName, accountNamesByLower) {
	return accountNamesByLower.get(trimText(accountName).toLowerCase()) || trimText(accountName);
}
function mapAccount(row) {
	const pnl = selectDailyPnl(row);
	return {
		connectionStatus: row.status,
		connection: trimText(row.connectionName),
		accountName: trimText(row.accountName),
		grossRealizedPnl: pnl.value,
		selectedPnl: pnl.value,
		realizedPnl: row.realizedPnl,
		rawRealizedPnl: row.realizedPnl,
		rawGrossRealizedPnl: row.grossRealizedPnl,
		grossRealizedPnlReported: row.grossRealizedPnl ?? null,
		pnlSource: pnl.source,
		trailingMaxDrawdown: row.trailingMaxDrawdown,
		isSimulated: typeof row.isSimulated === "boolean" ? row.isSimulated : void 0,
		accountBalance: row.cashValue,
		weeklyPnl: row.weeklyPnl,
		unrealizedPnl: row.unrealizedPnl
	};
}
function mapStrategy(row, connectionByAccount, accountNamesByLower) {
	const params = mapParameters(row.parameters);
	const accountName = canonicalAccountName(row.accountName, accountNamesByLower);
	return {
		id: trimText(row.strategyId),
		strategyName: trimText(row.strategyName),
		strategyFamily: normalizeStrategyFamily(row.strategyName),
		strategyVersion: parseStrategyVersion(row.strategyName),
		instrument: trimText(row.instrument),
		accountName,
		dataSeries: trimText(row.dataSeries),
		parametersRaw: stableJson(row.parameters),
		params,
		direction: params.direction,
		unrealized: row.unrealizedPnl,
		realized: row.realizedPnl,
		connection: trimText(row.connectionName) || connectionByAccount.get(accountName) || "",
		enabled: Boolean(row.enabled),
		sync: row.sync,
		state: row.state,
		position: row.position,
		averagePrice: row.averagePrice,
		startedAt: row.startedAt,
		parameterCaptureStatus: row.parameterCaptureStatus
	};
}
function mapOrder(row, accountNamesByLower) {
	return {
		instrument: trimText(row.instrument),
		action: trimText(row.action),
		orderType: trimText(row.orderType),
		quantity: row.quantity,
		limit: row.limitPrice,
		stop: row.stopPrice,
		state: trimText(row.state),
		filled: row.filled,
		avgPrice: row.averageFillPrice,
		remaining: row.remaining,
		name: row.name || "",
		strategyName: row.strategyName || "",
		strategyId: trimText(row.strategyId),
		accountName: canonicalAccountName(row.accountName, accountNamesByLower),
		id: trimText(row.orderId),
		time: row.time,
		tif: row.tif,
		oco: row.oco,
		nativeId: row.nativeId
	};
}
function mapExecution(row, accountNamesByLower) {
	return {
		instrument: trimText(row.instrument),
		action: trimText(row.action),
		quantity: row.quantity,
		price: row.price,
		time: row.time,
		id: trimText(row.executionId),
		entryExit: trimText(row.entryExit),
		position: row.marketPosition || "",
		orderId: trimText(row.orderId),
		name: row.name || "",
		strategyId: trimText(row.strategyId),
		strategyName: row.strategyName || "",
		commission: row.commission,
		fee: row.fee,
		rate: row.rate,
		realizedPnl: row.realizedPnl,
		accountName: canonicalAccountName(row.accountName, accountNamesByLower),
		connection: trimText(row.connectionName),
		nativeId: row.nativeId
	};
}
function strategyRowScore(row) {
	const position = trimText(row.position);
	const state = trimText(row.state).toLowerCase();
	return (position && position.toLowerCase() !== "null" ? 2 : 0) + (/realtime|active|running/.test(state) ? 1 : 0);
}
function repairStrategies(snapshot) {
	if (snapshot.accounts.length === 0 && snapshot.strategies.length > 0) return {
		snapshot,
		repairs: null
	};
	const accountsByLower = new Set(snapshot.accounts.map((account) => trimText(account.accountName).toLowerCase()));
	const keptByStrategyId = /* @__PURE__ */ new Map();
	const duplicateStrategyIds = /* @__PURE__ */ new Set();
	const unknownAccounts = /* @__PURE__ */ new Set();
	const order = [];
	let unknownAccountRowsDropped = 0;
	let duplicateRowsDropped = 0;
	for (const row of snapshot.strategies) {
		const accountName = trimText(row.accountName);
		if (!accountsByLower.has(accountName.toLowerCase())) {
			unknownAccounts.add(accountName === "" ? "(blank)" : accountName);
			unknownAccountRowsDropped += 1;
			continue;
		}
		const key = trimText(row.strategyId);
		const current = keptByStrategyId.get(key);
		if (!current) {
			keptByStrategyId.set(key, row);
			order.push(key);
			continue;
		}
		duplicateStrategyIds.add(key);
		duplicateRowsDropped += 1;
		if (strategyRowScore(row) >= strategyRowScore(current)) keptByStrategyId.set(key, row);
	}
	const repairs = { strategies: {
		duplicateRowsDropped,
		duplicateStrategyIds: [...duplicateStrategyIds],
		unknownAccountRowsDropped,
		unknownAccounts: [...unknownAccounts]
	} };
	return {
		snapshot: duplicateRowsDropped || unknownAccountRowsDropped ? {
			...snapshot,
			strategies: order.map((key) => keptByStrategyId.get(key))
		} : snapshot,
		repairs
	};
}
function validationError(snapshot) {
	const validation = validateAutoExportSnapshot(snapshot);
	const errors = [...validation.errors];
	if (validation.ok) errors.push(...duplicateErrors(snapshot), ...accountReferenceErrors(snapshot));
	if (!errors.length) return null;
	return new AutoImportValidationError(snapshot && typeof snapshot === "object" && Object.prototype.hasOwnProperty.call(snapshot, "schemaVersion") && snapshot.schemaVersion !== 1 ? "unsupported_schema_version" : "invalid_auto_import_snapshot", errors);
}
function normalizeAutoImportSnapshot(rawSnapshot) {
	const structural = validateAutoExportSnapshot(rawSnapshot);
	let snapshot = rawSnapshot;
	let repairs = null;
	if (structural.ok) ({snapshot, repairs} = repairStrategies(rawSnapshot));
	const error = validationError(snapshot);
	if (error) throw error;
	const accountNamesByLower = new Map(snapshot.accounts.map((account) => {
		const accountName = trimText(account.accountName);
		return [accountName.toLowerCase(), accountName];
	}));
	const connectionByAccount = new Map(snapshot.accounts.map((account) => [trimText(account.accountName), trimText(account.connectionName)]));
	const parsed = {
		accounts: snapshot.accounts.map(mapAccount),
		strategies: snapshot.strategies.map((row) => mapStrategy(row, connectionByAccount, accountNamesByLower)),
		orders: snapshot.orders.map((row) => mapOrder(row, accountNamesByLower)),
		executions: snapshot.executions.map((row) => mapExecution(row, accountNamesByLower))
	};
	const sectionCounts = Object.fromEntries(SECTION_NAMES.map((section) => [section, snapshot[section].length]));
	const emptySections = SECTION_NAMES.filter((section) => sectionCounts[section] === 0);
	const accountPnl = Object.fromEntries(parsed.accounts.map((account) => [account.accountName, {
		realizedPnl: account.rawRealizedPnl,
		grossRealizedPnl: account.rawGrossRealizedPnl,
		selectedPnl: account.selectedPnl,
		pnlSource: account.pnlSource
	}]));
	return {
		date: snapshot.tradingDate,
		parsed,
		metadata: {
			captureId: snapshot.captureId,
			capturedAt: snapshot.capturedAt,
			timeZone: snapshot.timeZone,
			source: snapshot.source,
			sectionCounts,
			missingSections: [],
			emptySections,
			isComplete: emptySections.length === 0,
			repairs,
			openPositions: openPositionsAt(snapshot),
			accountPnl
		}
	};
}
function lowerKeyed(roster = {}) {
	const out = /* @__PURE__ */ new Map();
	for (const [name, account] of Object.entries(roster || {})) if (name) out.set(String(name).toLowerCase(), {
		...account,
		accountName: name
	});
	return out;
}
function daysBetween(fromIso, toIso) {
	const from = Date.parse(fromIso);
	const to = Date.parse(toIso);
	if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
	return Math.floor((to - from) / 864e5);
}
/**
* The registry the report reads, with every account the capture holds.
*
* An account the roster explains keeps its classification. One it does not is
* named rather than guessed at, and `report.js` keeps it out of the total.
*/
function registryForCapture(parsed, roster = {}) {
	const byLower = lowerKeyed(roster);
	const registry = {};
	const pending = [];
	for (const account of parsed?.accounts || []) {
		const name = account?.accountName;
		if (!name) continue;
		const known = byLower.get(String(name).toLowerCase());
		if (known && known.accountType) registry[name] = {
			...known,
			accountName: name
		};
		else {
			registry[name] = {
				accountName: name,
				accountType: ACCOUNT_TYPES.PENDING_CLASSIFICATION
			};
			pending.push(name);
		}
	}
	return {
		registry,
		pending
	};
}
/**
* Everything the page needs, from one capture and one cached roster.
*
* `warnings` are for the reader, not for the log. Each one is a sentence the
* page prints, because a report that quietly rests on a week-old roster is
* worse than one that says it does.
*/
function buildOfflineDailyReport({ capture, roster = {}, rosterFetchedAt = null, clientName = "" } = {}) {
	if (!capture) throw new Error("No capture was given.");
	const { date, parsed, metadata } = normalizeAutoImportSnapshot(capture);
	if (!date) throw new Error("The capture does not say which trading day it is.");
	const { registry, pending } = registryForCapture(parsed, roster);
	const dailyImport = reconcileDailyImport({
		clientId: "offline",
		date,
		registry,
		parsed,
		history: [],
		priorImports: [],
		fillsLoaded: true
	});
	const client = {
		name: clientName || "Client",
		accountRegistry: registry,
		dailyImports: [{
			...dailyImport,
			date
		}]
	};
	const warnings = [];
	const open = metadata?.openPositions;
	if (open?.open) {
		const names = Array.isArray(open.accounts) ? open.accounts : [];
		const n = names.length;
		warnings.push(`${n || "Some"} account${n === 1 ? " had a position" : "s had positions"} still open when this capture was taken, so the day is not settled and the realized figures are short by whatever those positions closed at${names.length ? `: ${names.join(", ")}` : ""}.`);
	}
	if (metadata?.isComplete === false && (metadata.emptySections || []).length) warnings.push(`The capture carried nothing in: ${metadata.emptySections.join(", ")}.`);
	if (!Object.keys(roster || {}).length) warnings.push("This machine has never received an account roster from the CRM, so no account could be classified. Every figure below is per account; there is no total.");
	const age = rosterFetchedAt ? daysBetween(rosterFetchedAt, `${date}T00:00:00Z`) : null;
	if (age !== null && age >= 7) warnings.push(`The account roster on this machine is ${age} days old. Accounts opened since then are listed separately and are not in the total.`);
	if (pending.length) {
		const verb = pending.length === 1 ? "is" : "are";
		warnings.push(`${pending.length} account${pending.length === 1 ? "" : "s"} could not be classified from this machine and ${verb} shown separately, not in the total: ${pending.join(", ")}.`);
	}
	return {
		metadata,
		report: buildDailyReportSummary(client, {
			...dailyImport,
			date
		}),
		client,
		dailyImport: {
			...dailyImport,
			date
		},
		pending,
		rosterAgeDays: age,
		warnings
	};
}
//#endregion
//#region src/domain/agentReportMail.js
function fileStem(clientName, date) {
	return `${String(clientName || "Client").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Client"} - ${date} daily report`;
}
/** What a machine's own report is called in a mailbox, so it sorts by client. */
function subjectFor(clientName, date) {
	return `Daily report · ${clientName || "Client"} · ${date}`;
}
var AgentReportError = class extends Error {
	constructor(code, message) {
		super(message);
		this.name = "AgentReportError";
		this.code = code;
	}
};
/**
* @param capture           the machine's capture, exactly as it wrote it.
* @param roster            the roster it had cached, or nothing.
* @param rosterFetchedAt   ISO, or null.
* @param clientName        whose close this is.
* @param from,to           the addresses, which never come from the request.
* @returns {{ date, subject, text, attachments }}
*/
function buildAgentReportMessage({ capture, roster = {}, rosterFetchedAt = null, clientName = "", from, to }) {
	if (!capture) throw new AgentReportError("no_capture", "There is no capture in the request.");
	let built;
	try {
		built = buildOfflineDailyReport({
			capture: redactCapture(capture),
			roster: roster || {},
			rosterFetchedAt: rosterFetchedAt || null,
			clientName
		});
	} catch (error) {
		throw new AgentReportError("bad_capture", error?.message || "The capture could not be read.");
	}
	const date = built?.report?.date || "";
	const html = renderOfflineReport(built);
	const stem = fileStem(clientName, date);
	const warnings = built.warnings || [];
	const lines = [
		`${clientName || "Client"} · ${date}`,
		"",
		"Built on the trading machine from its own captured close, without the CRM.",
		"Account classification comes from the last roster the CRM was able to send to that machine."
	];
	if (warnings.length) {
		lines.push("", "Read before sending:");
		for (const warning of warnings) lines.push(`  • ${warning}`);
	}
	return {
		date,
		from,
		to,
		subject: subjectFor(clientName, date),
		text: lines.join("\n"),
		attachments: [{
			name: `${stem}.zip`,
			bytes: zipSync({ [`${stem}.html`]: strToU8(html) }, { level: 6 })
		}]
	};
}
//#endregion
export { AgentReportError, EmailDeliveryError, buildAgentReportMessage, buildDailyEmailPackage, planDailyEmails, runDailyEmails, sendViaBrevo, usersFromRows };
