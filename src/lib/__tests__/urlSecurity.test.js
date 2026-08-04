import { describe, expect, it } from 'vitest';
import { describeEndpointValidationError, normalizeHttpsEndpoint } from '@/lib/urlSecurity';

// This module is the gate in front of user-configured OSRM endpoints. Anything
// it lets through becomes a host the app will send sampled GPS coordinates to,
// so the plaintext and non-URL cases matter as much as the happy path.
describe('normalizeHttpsEndpoint', () => {
  it('accepts an HTTPS endpoint and trims the trailing slash', () => {
    expect(normalizeHttpsEndpoint('https://routing.example.test/')).toBe('https://routing.example.test');
    expect(normalizeHttpsEndpoint('  https://routing.example.test/osrm/  ')).toBe('https://routing.example.test/osrm');
  });

  it('rejects plaintext HTTP by default', () => {
    expect(normalizeHttpsEndpoint('http://routing.example.test')).toBe('');
  });

  it('rejects non-HTTP schemes that could exfiltrate or execute', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://routing.example.test',
    ]) {
      expect(normalizeHttpsEndpoint(value)).toBe('');
    }
  });

  it('rejects values that are not URLs at all', () => {
    for (const value of ['', '   ', 'not a url', 'routing.example.test', null, undefined, 42, {}]) {
      expect(normalizeHttpsEndpoint(value)).toBe('');
    }
  });

  it('allows loopback HTTP only when the caller opts in', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(normalizeHttpsEndpoint(`http://${host}:5000`)).toBe('');
      expect(normalizeHttpsEndpoint(`http://${host}:5000`, { allowLoopbackHttp: true }))
        .toBe(`http://${host}:5000`);
    }
  });

  it('does not treat a lookalike host as loopback', () => {
    // Hosts that merely contain or resemble a loopback name are still remote.
    for (const host of ['localhost.evil.test', 'notlocalhost', '127.0.0.1.evil.test']) {
      expect(normalizeHttpsEndpoint(`http://${host}`, { allowLoopbackHttp: true })).toBe('');
    }
  });

  it('matches loopback hosts case-insensitively', () => {
    expect(normalizeHttpsEndpoint('http://LOCALHOST:5000', { allowLoopbackHttp: true }))
      .toBe('http://localhost:5000');
  });
});

describe('describeEndpointValidationError', () => {
  it('stays silent for an empty value and for a valid HTTPS endpoint', () => {
    expect(describeEndpointValidationError('')).toBe('');
    expect(describeEndpointValidationError('   ')).toBe('');
    expect(describeEndpointValidationError('https://routing.example.test')).toBe('');
  });

  it('explains the HTTPS requirement, mentioning loopback only when allowed', () => {
    expect(describeEndpointValidationError('http://routing.example.test'))
      .toBe('Endpoint must use HTTPS.');
    expect(describeEndpointValidationError('http://routing.example.test', { allowLoopbackHttp: true }))
      .toBe('Endpoint must use HTTPS, except loopback HTTP for local development.');
  });

  it('reports unparseable input separately from a scheme problem', () => {
    expect(describeEndpointValidationError('not a url')).toBe('Endpoint must be a valid URL.');
  });

  it('agrees with normalizeHttpsEndpoint on what is acceptable', () => {
    const cases = [
      ['https://routing.example.test', {}],
      ['http://routing.example.test', {}],
      ['http://localhost:5000', { allowLoopbackHttp: true }],
      ['http://localhost:5000', {}],
      ['javascript:alert(1)', {}],
    ];

    for (const [value, options] of cases) {
      const accepted = normalizeHttpsEndpoint(value, options) !== '';
      const errorFree = describeEndpointValidationError(value, options) === '';
      expect(errorFree, `disagreement for ${value}`).toBe(accepted);
    }
  });
});
