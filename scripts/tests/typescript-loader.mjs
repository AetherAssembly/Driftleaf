export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?js$|\.ts$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Let Node report the original resolution failure below.
    }
  }
  return nextResolve(specifier, context);
}
