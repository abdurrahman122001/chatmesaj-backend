import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "info@chatmesaj.cc";
  const password = "admin1234";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Admin already exists:", email);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 10),
      name: "Admin",
      role: "ADMIN",
      sites: {
        create: {
          name: "Demo Site",
          apiKey: "demo_" + Math.random().toString(36).slice(2, 10),
          quickActions: { whatsapp: "", email: "", telegram: "" },
        },
      },
    },
    include: { sites: true },
  });

  const siteId = user.sites[0].id;

  // Sample knowledge entries
  const sampleEntries = [
    {
      title: "Çatdırılma müddəti",
      content:
        "Sifarişləriniz Bakı şəhərində 24 saat ərzində, regionlara 2-3 iş günündə çatdırılır. Sifariş verdikdən sonra sizinlə əlaqə saxlayacağıq və dəqiq tarix razılaşdırılacaq.",
      tags: ["çatdırılma", "delivery"],
    },
    {
      title: "Geri qaytarma siyasəti",
      content:
        "Məhsulu aldıqdan sonra 14 gün ərzində geri qaytara bilərsiniz. Məhsul işlədilməmiş vəziyyətdə və orijinal qablaşdırmada olmalıdır. Geri qaytarma üçün bizimlə əlaqə saxlayın.",
      tags: ["qaytarma", "refund"],
    },
    {
      title: "Ödəniş üsulları",
      content:
        "Biz nağd, bank kartı (Visa, Mastercard), bank köçürməsi və online ödəniş qəbul edirik. Bütün online ödənişlər təhlükəsiz SSL kanal üzərindən həyata keçirilir.",
      tags: ["ödəniş", "payment"],
    },
    {
      title: "İş saatları",
      content: "Bazar ertəsi - Cümə: 09:00 - 18:00. Şənbə: 10:00 - 16:00. Bazar günü istirahət günüdür. Təcili hallarda WhatsApp üzərindən bizə yazın.",
      tags: ["saatlar", "hours"],
    },
    {
      title: "Əlaqə məlumatları",
      content:
        "Bizə email vasitəsilə info@chatmesaj.cc ünvanından, telefonla +994 50 XXX XX XX nömrəsindən və ya ofisimizdə yerləşən ünvandan müraciət edə bilərsiniz.",
      tags: ["əlaqə", "contact"],
    },
  ];

  for (const e of sampleEntries) {
    await prisma.knowledgeEntry.create({ data: { siteId, ...e } });
  }

  console.log("✓ Seeded admin user:");
  console.log("  email:", email);
  console.log("  password:", password);
  console.log("  siteId:", siteId);
  console.log("  apiKey:", user.sites[0].apiKey);
  console.log("  knowledge entries:", sampleEntries.length);
  console.log("\n⚠ Next step: Apply full-text search setup:");
  console.log("  psql $DATABASE_URL -f prisma/fts_setup.sql");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
