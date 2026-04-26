import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const sites = await prisma.site.findMany({
  select: { id: true, name: true, apiKey: true, owner: { select: { email: true } } },
});

console.log("\n=== SITES ===");
if (!sites.length) {
  console.log("Heç bir site yoxdur. `npm run seed` işlədin.");
} else {
  sites.forEach((s) => {
    console.log(`- ${s.name}`);
    console.log(`  owner : ${s.owner?.email}`);
    console.log(`  apiKey: ${s.apiKey}`);
    console.log(`  siteId: ${s.id}`);
  });
}
await prisma.$disconnect();
