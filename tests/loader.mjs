// Resolve only the two peer imports; exercise the actual plugin source unchanged.
export function resolve(specifier, context, nextResolve) {
  if (['@deepseek-ai/dsh-web', '@deepseek-ai/dsh-launch-environment'].includes(specifier)) {
    return { url: new URL('./peer-stubs.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
