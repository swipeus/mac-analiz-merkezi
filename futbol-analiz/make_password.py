"""Rastgele, akılda kalır bir site şifresi üretip ../site-sifresi.txt dosyasına yazar (varsa dokunmaz)."""
import secrets
from pathlib import Path

PW_FILE = Path(__file__).resolve().parent.parent / "site-sifresi.txt"
if PW_FILE.exists():
    print("Şifre dosyası zaten var:", PW_FILE.name)
else:
    words = ["korner", "ofsayt", "frikik", "penalti", "kontra", "pres", "libero", "stoper", "forvet", "kanat",
             "rovesata", "jenerik", "tribun", "derbi", "kaptan", "golcu"]
    pw = "-".join(secrets.choice(words) for _ in range(3)) + "-" + str(secrets.randbelow(900) + 100)
    PW_FILE.write_text(pw, encoding="utf-8")
    print("Şifre oluşturuldu:", PW_FILE.name)
