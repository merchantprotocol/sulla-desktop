# SPDX-License-Identifier: Apache-2.0
import re

def handler(inputs: dict) -> dict:
    html = inputs.get('html', '') or ''
    robots = inputs.get('robots', '') or ''
    llms = inputs.get('llms', '') or ''
    checks = [
        {'check': 'title', 'ok': bool(re.search(r'<title\b[^>]*>\s*.+?\s*</title>', html, re.I|re.S))},
        {'check': 'meta description', 'ok': bool(re.search(r'<meta\b[^>]+name=["\']description["\'][^>]*>', html, re.I))},
        {'check': 'heading', 'ok': bool(re.search(r'<h1\b[^>]*>\s*.+?\s*</h1>', html, re.I|re.S))},
        {'check': 'structured data', 'ok': bool(re.search(r'application/ld\+json', html, re.I))},
        {'check': 'robots.txt present', 'ok': bool(robots.strip())},
        {'check': 'llms.txt present', 'ok': bool(llms.strip())},
    ]
    return {'checks': checks}
