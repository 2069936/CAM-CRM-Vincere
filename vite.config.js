import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})