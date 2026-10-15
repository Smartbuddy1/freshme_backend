The public Supabase Root 2021 CA is bundled to verify Supabase database TLS.
Source: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

It is a public certificate, not a private key. The driver uses it only for
Supabase hostnames. Other providers use the system trust store. Set
DATABASE_CA_CERT to an absolute path for a different CA (mount that file into
the container if deploying with Docker). Never disable certificate validation.

Renew this file when Supabase changes its CA. The certificate can also be
downloaded from the project's Database Settings / SSL Configuration page:
https://supabase.com/docs/guides/platform/ssl-enforcement
