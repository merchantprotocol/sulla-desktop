export async function handler(inputs) {
  return { result: `Hello, ${inputs.name ?? 'world'}!` };
}
