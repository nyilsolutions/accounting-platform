# Mail

**Alarms:** `acct-<env>-ses-bounces` (bounce rate over 4%), `-ses-complaints` (complaint rate
over 0.08%). SES reviews an account at 5% bounces or 0.1% complaints and can pause sending,
which would stop sign-in codes, invitations and security emails.

1. **Who is bouncing?** The `acct-<env>-mail-events` topic receives each bounce and complaint.
   Subscribe an email or a queue to it while investigating. SES adds bouncing and complaining
   addresses to the account's suppression list by itself.
2. **A burst from one company:** a customer list with bad addresses (invoices, statements,
   portal links). Ask the company to correct the addresses.
3. **Complaints:** check what was sent (scheduled reports, reminders). Only transactional mail
   is sent; nothing marketing.
4. **Sending paused by SES:** open a case with AWS from the SES console with what changed and
   what was fixed. Meanwhile, sign-in still works for users with an authenticator app; mail
   based steps (invitations, password resets, portal links) wait.
5. **DNS:** DKIM, SPF (MAIL FROM) and DMARC must stay in place. `aws sesv2 get-email-identity
--email-identity <mail domain>` shows the DKIM status.
