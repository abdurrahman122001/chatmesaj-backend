// İstifadə:
//   node scripts/reset-password.js <email> <new-password>
// Nümunə:
//   node scripts/reset-password.js admin@example.com NewPass123
//
// Qeyd: bu skripti `server/` qovluğundan işə salın ki, .env və prisma düzgün yüklənsin.

import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

async function main() {
  const [, , emailArg, passwordArg] = process.argv;
  if (!emailArg || !passwordArg) {
    console.error("İstifadə: node scripts/reset-password.js <email> <new-password>");
    process.exit(1);
  }
  if (passwordArg.length < 8) {
    console.error("Şifrə minimum 8 simvol olmalıdır.");
    process.exit(1);
  }

  const email = emailArg.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`İstifadəçi tapılmadı: ${email}`);
    console.error("Mövcud istifadəçilər:");
    const all = await prisma.user.findMany({ select: { email: true, role: true } });
    for (const u of all) console.error(`  - ${u.email} (${u.role})`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(passwordArg, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, twoFactorEnabled: false, twoFactorSecret: null },
  });

  console.log(`✔ Şifrə yeniləndi: ${email}`);
  console.log("  (2FA varsa sıfırlandı — yenidən daxil ola bilərsən.)");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
