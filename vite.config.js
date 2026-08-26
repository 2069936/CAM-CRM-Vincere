import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { configDefaults } from "vitest/config"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hasLocalSnapshot = fs.existsSync(path.resolve(__dirname, "public/local-snapshot.json"))
/**
 * Suites that CANNOT run without public/local-snapshot.json.
 *
 * Everything listed here is dropped on a clone that does not hold the book, so
 * nothing listed here is pinned by CI. That makes the list a liability as well
 * as a convenience, and it has already cost something: the two guards that stop
 * a partial or an over-summing derived per-algo split from reaching a screen
 * lived in a gated file, and both mutations that break them passed a full CI
 * run. They now live in src/domain/algoContribution.test.js, which is not gated.
 *
 * THE RULE, and it is the only one: a file belongs on this list if and only if
 * it reads the book. A file that mixes book-backed assertions with synthetic
 * ones gets SPLIT — `X.book.test.js` holds the half that needs the export and
 * goes on the list, `X.test.js` keeps the synthetic half and stays off it.
 * Adding a whole mixed file here to make one assertion runnable silently
 * un-pins every synthetic test beside it.
 *
 * Membership is checked by src/localSnapshotGate.test.js, which fails if a
 * listed file does not read the snapshot or an unlisted one does — the second
 * half of that check is not hypothetical either: quietAccounts.test.js and
 * QuietAccountsPanel.test.jsx were absent from this list while reading the book
 * at import time, so a snapshot-less `vitest run` failed outright.
 */
export const localSnapshotTests = [
  "src/components/AccountLifecyclePanel.test.jsx",
  "src/components/AlgoContributionPanel.book.test.jsx",
  "src/components/AlgorithmDetailPanel.book.test.jsx",
  "src/components/BulletBotDeskPanel.test.jsx",
  "src/components/CamFlagQueue.book.test.jsx",
  "src/components/CapitalDetailPanel.test.jsx",
  "src/components/ConfigDriftPanel.book.test.jsx",
  "src/components/LiveAccountsPanel.test.jsx",
  "src/components/QuietAccountsPanel.test.jsx",
  "src/components/SetFileMatchPanel.test.jsx",
  "src/components/TimeOffPanel.test.jsx",
  "src/domain/accountLifecycle.book.test.js",
  "src/domain/accountTypeAlgorithm.book.test.js",
  "src/domain/algoContribution.book.test.js",
  "src/domain/algorithmRanking.book.test.js",
  "src/domain/camFlagQueue.book.test.js",
  "src/domain/camOverview.book.test.js",
  "src/domain/clientExportPlan.book.test.js",
  "src/domain/clientLifecycle.book.test.js",
  "src/domain/deskMoney.book.test.js",
  "src/domain/liveAccounts.book.test.js",
  "src/domain/quietAccounts.book.test.js",
  "src/domain/setFileMatch.test.js",
  "src/domain/sidebarClientList.test.js",
  "src/domain/supabaseLoadCost.book.test.js",
  "src/domain/synthesizedReference.book.test.js",
  "src/insightFeed.book.test.js",
  "src/printLayout.book.test.js",
]

/**
 * Keeps the local snapshot out of the deploy output.
 *
 * public/local-snapshot.json is a real export of the book — every client, every
 * account, every balance. .gitignore keeps it out of the repo, and
 * src/domain/localSnapshot.js already claimed it was "kept out of the bundle",
 * but nothing enforced that: Vite copies publicDir into dist wholesale, so a
 * local `npm run build` was writing 64 MB of client data into the directory a
 * deploy uploads. The normal Vercel path builds from git and never sees the
 * file; `vercel deploy --prebuilt`, or any hand-upload of dist, would have
 * shipped it.
 *
 * Deleting after the copy rather than excluding before it: publicDir has no
 * per-file filter, and a plugin that silently rewrote the copy would be the
 * kind of indirection nobody finds when this breaks.
 */
function excludeLocalSnapshot() {
  return {
    name: "exclude-local-snapshot",
    apply: "build",
    closeBundle() {
      const target = path.resolve(__dirname, "dist/local-snapshot.json")
      if (!fs.existsSync(target)) return
      const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1)
      fs.rmSync(target)
      // Logged, not silent: someone expecting the snapshot to be served from a
      // built preview needs to know why it is not there.
      this.warn(`removed dist/local-snapshot.json (${mb} MB of real client data) from the build output`)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excludeLocalSnapshot()],
  test: {
    // These suites intentionally assert aggregate values from the untracked,
    // redacted production book. Keep ordinary clones and CI green without
    // weakening those assertions when the local fixture is present.
    exclude: [
      ...configDefaults.exclude,
      ...(hasLocalSnapshot ? [] : localSnapshotTests),
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
