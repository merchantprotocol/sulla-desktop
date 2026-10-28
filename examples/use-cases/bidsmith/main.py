# SPDX-License-Identifier: Apache-2.0
def handler(inputs: dict) -> dict:
    title = str(inputs['title']).strip()
    out = [f'# {title}', '']
    for section in inputs.get('sections', []):
        heading = str(section.get('heading', 'Open question')).strip()
        body = str(section.get('body', '')).strip()
        out.extend([f'## {heading}', body, ''])
    return {'markdown': '\n'.join(out).rstrip() + '\n'}
