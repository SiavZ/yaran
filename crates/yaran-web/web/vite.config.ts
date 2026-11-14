/// <reference types="vitest/config" />
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    // @yaran/ui-kit is a file: dependency, so npm links it. Keeping the link path
    // makes the kit's own imports resolve from this package's node_modules, and
    // dedupe pins every kit peer to one copy: two Reacts break every hook.
    preserveSymlinks: true,
    dedupe: [
      "react",
      "react-dom",
      "@base-ui/react",
      "lucide-react",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "sonner",
    ],
  },
  test: { setupFiles: ["./src/testSetup.ts"] },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        // `codeSplitting.groups` is rolldown's current (non-deprecated)
        // manual-chunking API. Pulling the React runtime out of the entry keeps
        // the eagerly-loaded app chunk under the 500KB warning limit; `[\\/]`
        // matches the path separator portably, as rolldown recommends.
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
