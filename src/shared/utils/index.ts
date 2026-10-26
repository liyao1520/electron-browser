export function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input)

    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
  } catch {
    return false
  }
}
