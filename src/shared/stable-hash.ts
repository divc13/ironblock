/**
 * Deterministic helpers used wherever ordering or identifiers must not depend on
 * the host locale, object insertion order or a weak 32-bit hash.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const UINT64_MASK = 0xffffffffffffffffn

/** Locale-independent codepoint ordering. */
export function stableCompare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * JSON-like serialization with recursively sorted object keys. Arrays retain
 * their order because array order is semantically meaningful.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'object':
      break
    default:
      return JSON.stringify(String(value))
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort(stableCompare)

  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

/** 64-bit FNV-1a hash, returned as 16 lowercase hexadecimal characters. */
export function stableHash64(value: string): string {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * FNV_PRIME) & UINT64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/** Deterministic bucket in [0, length) derived from a stable 64-bit hash. */
export function stableHashIndex(value: string, length: number): number {
  if (!Number.isSafeInteger(length) || length <= 0) return 0
  const hash = BigInt(`0x${stableHash64(value)}`)
  return Number(hash % BigInt(length))
}
