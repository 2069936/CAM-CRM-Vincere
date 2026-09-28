var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
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
RESIDUAL_REASONS.CARRY_IN, RESIDUAL_REASONS.UNKNOWN_INSTRUMENT, RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE;
Object.keys(SPECS).sort((a, b) => b.length - a.length);
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
//#endregion
//#region src/domain/strategyRan.js
/** The four answers, strongest evidence first. */
var RAN_BASES = [
	"enabled",
	"fills",
	"realized",
	"none"
];
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
var ACCOUNT_STATUSES = {
	ACTIVE: "Active",
	INACTIVE: "Inactive",
	RESERVE: "Reserve",
	FAILED: "Failed",
	PAYOUT_HOLD: "Payout Hold"
};
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
//#region node_modules/fflate/esm/browser.js
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
function subjectFor(date, clientCount) {
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
		subject: subjectFor(date, built.length),
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
function fileStem(clientName, date) {
	return `${String(clientName || "Client").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "Client"} - ${date} daily report`;
}
function entryNames(built, date) {
	const counts = /* @__PURE__ */ new Map();
	for (const item of built) {
		const stem = fileStem(item.client?.name, date);
		counts.set(stem, (counts.get(stem) || 0) + 1);
	}
	return built.map((item) => {
		const stem = fileStem(item.client?.name, date);
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
export { EmailDeliveryError, buildDailyEmailPackage, planDailyEmails, runDailyEmails, sendViaBrevo, usersFromRows };
