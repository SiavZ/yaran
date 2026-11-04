import { lazy, Suspense, type ComponentProps } from "react"

import { ChunkBoundary } from "@/components/ChunkBoundary"
import type { EditorBody as EditorBodyComponent } from "@/components/EditorBody"

// Both shells defer the editor's tree, search, and tools until it opens.
const EditorBody = lazy(() =>
  import("@/components/EditorBody").then((m) => ({ default: m.EditorBody })),
)

export function LazyEditorBody(props: ComponentProps<typeof EditorBodyComponent>) {
  return (
    <ChunkBoundary>
      <Suspense fallback={
        <div role="status" className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading editor…
        </div>
      }>
        <EditorBody {...props} />
      </Suspense>
    </ChunkBoundary>
  )
}
