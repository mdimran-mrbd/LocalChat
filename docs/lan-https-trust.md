# Trusting LocalChat on your local network

LocalChat uses HTTPS so browsers can use secure-context features such as camera/microphone access and Web Crypto. On a private LAN, the server cannot obtain a publicly trusted certificate for a private IP address such as `192.168.0.153`. LocalChat therefore creates a persistent local certificate authority (CA) and issues its server certificate from that CA.

## First-time setup

1. Start LocalChat on the host computer and keep it running.
2. On the host, locate the public CA certificate at `tls/ca-cert.pem` inside LocalChat's data folder. The app prints the full path at startup. **Only copy `ca-cert.pem`; never share `ca-key.pem`, `key.pem`, or any private key.**
3. Transfer `ca-cert.pem` to each device that will connect, using a trusted method (for example, a USB drive or a trusted private file transfer). Do not install a certificate received from an unexpected server.
4. Install the CA certificate into that device's trusted root certificate store, then fully close and reopen the browser.
5. Visit the LocalChat LAN URL shown by the host, for example `https://192.168.0.153` (include the port if the app shows one).

The CA certificate is public, but trusting it means that device will trust server certificates issued by this LocalChat host. Only install it on devices you control or intentionally trust.

## Windows (Chrome / Edge)

1. On the client PC, double-click `ca-cert.pem`. If Windows does not offer the certificate import wizard for PEM, open it in the Certificates MMC snap-in or convert a copy to DER/CRT format without changing the certificate.
2. Choose **Install Certificate**.
3. Choose **Local Machine** only if you have administrator rights and want all Windows users to trust it; otherwise choose **Current User**.
4. Select **Place all certificates in the following store**, then choose **Trusted Root Certification Authorities**.
5. Finish the wizard, confirm the certificate details, and restart Chrome or Edge.

Windows may display a warning when installing a root CA. Verify that the certificate came from your own LocalChat host before trusting it.

## Other devices

Use the operating system's certificate-management settings to install the CA as a trusted root. Android and iOS have additional confirmation steps, and some apps do not trust user-installed CAs. Restart the browser after installation.

## If the warning remains

- Make sure you installed the CA certificate from the same LocalChat host you are visiting.
- Use the exact LAN IP/hostname and port printed by LocalChat.
- Check that the host's LAN IP has not changed. Restart LocalChat after network changes so it can issue a certificate containing the current LAN addresses.
- Do not delete `tls/ca-key.pem` or `tls/ca-cert.pem`; deleting them creates a new CA, and every client would need to trust the new CA.
