import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui's class joiner, used by the vendored AI Elements and their primitives. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
