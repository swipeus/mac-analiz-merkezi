# Maç Analiz Merkezi (kişisel kullanım)

**Başlatmak için:** `baslat.bat` dosyasına çift tıklayın. Tarayıcıda http://localhost:8765 açılır.
Pencere açık kaldığı sürece arka plan güncelleyici çalışır.

## Ne yapar
- 14 lig: Süper Lig, top 5 lig, Eredivisie, Portekiz, Belçika, Championship, İskoçya, ŞL, Avrupa Ligi, Konferans Ligi
- Her maç için: olası/resmi 11, saha dizilişi, sakat ve cezalı oyuncular, son 5 maçın detaylı istatistikleri
  (şut, ceza sahası içi/dışı, xG akan oyun/duran top, korner, müdahale, top kesme, uzaklaştırma, hava topu…),
  sezon istatistikleri ve lig sıralamaları, kilit oyuncular, H2H, Türkçe haberler
- Takım analizi (oyun planı, hücum, duran top, savunma, form, eksikler) ve senaryolar
- Poisson modeliyle 1X2, skor, alt/üst, KG, korner, şut ve kart beklentisi
- Değişiklikleri arka planda yakalar (resmi 11, yeni eksik, yeni haber, gol, maç başladı/bitti) ve
  açık sayfaya anlık bildirim gönderir

## Güncelleme sıklığı
Canlı maç 2 dk · başlamasına 3 saatten az kalan maç 5 dk · gün içindeki diğer maçlar 20 dk · yarının maçları 3 saat.
Ayarlar: `app/config.py`.

## Kaynaklar ve sınırlar
- FotMob'un resmi olmayan API'si kullanılır; FotMob değişiklik yaparsa çalışmayı durdurabilir.
  Veri sağlayıcı lige göre değişir (sayfada "Kaynaklar" bölümünde yazar).
- Türkçe haberler Google News RSS'ten gelir. Takım adıyla arandığı için ilgisiz haber de çıkabilir.
- Tahminler istatistiksel modeldir, kesinlik içermez.

## Çevrimiçi sürüm (GitHub Actions + GitHub Pages, ücretsiz)
Bilgisayar kapalıyken de çalışan sürüm:
- `.github/workflows/guncelle.yml` 15 dakikada bir çalışır. `build_static.py` verileri toplar,
  analiz eder ve **şifreli** JSON dosyaları olarak GitHub Pages'e yayınlar.
- Tarayıcı verileri site şifresiyle çözer (AES-256-GCM, PBKDF2). Şifre GitHub'da `SITE_PASSWORD`
  gizli değişkenindedir; yerel kopyası `site-sifresi.txt` dosyasındadır (GitHub'a gönderilmez).
- Önceki analizler ve önbellek Actions cache'inde saklanır (değişiklik bildirimleri için).
- Canlı skorlar ve bildirimler en fazla ~15-20 dakika gecikmeli gelir.
- GitHub, 60 gün boyunca depoda hiç değişiklik olmazsa zamanlanmış çalışmayı durdurur.
  Durursa Actions sekmesinden "Enable workflow" ile tekrar açılır.

Şifreyi değiştirmek için: `gh secret set SITE_PASSWORD` (sonra Actions'tan iş akışını elle çalıştır).
Elle güncelleme: GitHub'da Actions → "Verileri güncelle ve yayınla" → Run workflow.

Not: `Dockerfile` ve `app/main.py` canlı sunucu sürümü içindir (kart isteyen platformlar için).

## Dosyalar
- `app/sources.py`: FotMob ve Google News istekleri (SQLite önbellekli)
- `app/collect.py`: maç paketini oluşturur (kadro, istatistik, haber)
- `app/analysis.py`: Türkçe analiz, senaryolar, Poisson tahmini
- `app/updater.py`: arka plan döngüsü ve değişiklik bildirimleri
- `app/main.py`: web sunucusu (FastAPI) ve canlı bildirim akışı (SSE)
- `static/`: arayüz
