package play.ott.foss;

import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/** Adds the packaged public root only to legacy APK downloads, never global TLS. */
final class LegacyUpdateTls {
    private LegacyUpdateTls() {}

    static SSLSocketFactory create(InputStream root) throws Exception {
        X509Certificate certificate = (X509Certificate)
            CertificateFactory.getInstance("X.509").generateCertificate(root);
        if (certificate.getBasicConstraints() < 0) throw new CertificateException("Expected a CA");
        certificate.checkValidity();
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        store.load(null, null);
        store.setCertificateEntry("legacy-update-root", certificate);
        X509TrustManager platform = manager(null);
        X509TrustManager supplemental = manager(store);
        X509TrustManager combined = new X509TrustManager() {
            @Override public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                try {
                    platform.checkServerTrusted(chain, authType);
                } catch (CertificateException platformFailure) {
                    // The fallback still verifies the complete chain and validity periods.
                    supplemental.checkServerTrusted(chain, authType);
                }
            }

            @Override public void checkClientTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                platform.checkClientTrusted(chain, authType);
            }

            @Override public X509Certificate[] getAcceptedIssuers() {
                ArrayList<X509Certificate> issuers = new ArrayList<>(Arrays.asList(platform.getAcceptedIssuers()));
                issuers.addAll(Arrays.asList(supplemental.getAcceptedIssuers()));
                return issuers.toArray(new X509Certificate[0]);
            }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[] { combined }, null);
        // HttpsURLConnection retains its standard hostname verifier.
        return context.getSocketFactory();
    }

    private static X509TrustManager manager(KeyStore store) throws GeneralSecurityException {
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init(store);
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) return (X509TrustManager) manager;
        }
        throw new GeneralSecurityException("X509 trust manager unavailable");
    }
}
