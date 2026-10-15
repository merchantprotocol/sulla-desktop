/**
 * Package topics — the fixed set of use-case groups the Packages browser
 * sections are built from. Keys match the `topic` field of a package
 * manifest; order here is the order sections render in.
 */
export const PACKAGE_TOPICS = [
  { key: 'customers', label: 'Get more customers', blurb: 'Find people and win them faster.' },
  { key: 'service', label: 'Customer service', blurb: 'Keep the customers you have happy.' },
  { key: 'marketing', label: 'Marketing & content', blurb: 'Posts, videos and content that go out on their own.' },
  { key: 'money', label: 'Money & admin', blurb: 'Invoices, bills and paperwork.' },
  { key: 'team', label: 'Hiring & team', blurb: 'Hiring and keeping the team on track.' },
  { key: 'research', label: 'Research', blurb: 'Know what is going on without digging.' },
  { key: 'home', label: 'Home & personal', blurb: 'Help at home, not just at work.' },
] as const;

export type PackageTopicKey = typeof PACKAGE_TOPICS[number]['key'];

export function packageTopicLabel(key: string | null | undefined): string {
  return PACKAGE_TOPICS.find(t => t.key === key)?.label ?? '';
}
