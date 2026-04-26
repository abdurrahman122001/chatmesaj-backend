import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const site = await prisma.site.findFirst();
  if (site) {
    await prisma.site.update({
      where: { id: site.id },
      data: { apiKey: "demo_8oa2dmdu" }
    });
    console.log("API key updated to: demo_8oa2dmdu");
  } else {
    console.log("No site found");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
