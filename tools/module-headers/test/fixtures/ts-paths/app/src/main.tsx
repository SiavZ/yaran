// App entry: exercises every import form the resolver must handle.
import { a } from "@/lib/a";
import type { T } from "./types";
import React from "react";
import { Button } from "@yaran/ui-kit";
import { tok } from "@yaran/ui-kit/tokens";
import { readFileSync } from "node:fs";

export async function main(t: T) {
  const lazy = await import("./lazy");
  return [a, React, Button, tok, lazy, readFileSync, t];
}
