// Which yaran this page opened on, and whether the yaran answering now is that one.
//
// Every yaran keeps a random instance id across its restarts and reports it on
// the status and build reads. The page takes the id its own boot was told and
// compares every later report against it, so a restart of its own yaran (same
// id) is told apart from a different yaran answering at the same address (another
// id). The comparison is of what the yaran REPORTS, never of the page's own
// address: the address is exactly what stayed the same when the yaran behind it
// changed.
//
// A consistency check only. The id is public and anyone can repeat it, so it
// never decides anything about trust or sign-in; it only decides which cover
// the page shows.

export type InstanceVerdict = "same" | "different" | "unknown"

/// The verdict for a report against the remembered id. Unknown on either side
/// is never "different": a yaran too old to report one, or a read that did not
/// answer, is no evidence of a change.
export function compareInstances(
  opened: string | null,
  reported: string | null,
): InstanceVerdict {
  if (opened === null || reported === null) return "unknown"
  return opened === reported ? "same" : "different"
}

let opened: string | null = null
// Whether the boot has been answered. Its answer is the yaran this page opened
// on, an unknown one included: a page that booted without an id stays without
// one, rather than taking whichever yaran answers later for its own.
let decided = false

/// Weigh a report from the page's own boot (its first status read, or its
/// first build read): the first one decides which yaran the page opened on.
export function noteBootInstance(reported: string | null): InstanceVerdict {
  if (!decided) {
    decided = true
    opened = reported
  }
  return compareInstances(opened, reported)
}

/// Weigh any later report against the yaran the page opened on.
export function noteReportedInstance(reported: string | null): InstanceVerdict {
  return compareInstances(opened, reported)
}

/// The id this page opened on, or null when it is not known.
export function openedInstance(): string | null {
  return opened
}
