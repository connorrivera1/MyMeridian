# MyMeridian Outlook signature setup

Use the checked-in logo asset at
`public/assets/mymeridian-email-logo.png` (388 × 104 pixels). It is the same
restrained Meridian mark used by the email templates; no generated branding is
required.

1. Upload or host that file at the stable HTTPS address
   `https://mymeridian.io/assets/mymeridian-email-logo.png` after the public
   domain is live. Outlook signatures work most reliably with a public HTTPS
   image rather than a local file.
2. In Outlook, create separate signatures for `welcome@mymeridian.io` and
   `support@mymeridian.io`. Insert the logo at 174 × 47 pixels, then add the
   address, website and exact tagline: **Know what you kept. Know what to
   fix.**
3. Paste the exact markup in [`EMAIL_SIGNATURE.html`](EMAIL_SIGNATURE.html)
   into an HTML-capable signature editor, replacing the address for the
   support signature; use the same fields manually if the Outlook client
   strips HTML.
4. Set the Microsoft 365 profile image personally in Outlook/Microsoft admin
   after the mailbox/alias is active. No profile setting is changed by this
   repository.

The human signature and Resend transactional template intentionally use the
same logo and fallback system fonts, but are separate: an Outlook signature is
not an authorization to send product newsletters.
