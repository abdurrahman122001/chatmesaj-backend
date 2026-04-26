import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const oldUser = await prisma.user.findUnique({ where: { email: "admin@example.com" } });
  if (oldUser) {
    console.log("Old user found:");
    console.log(`  Email: ${oldUser.email}`);
    console.log(`  Name: ${oldUser.name}`);
    console.log(`  Role: ${oldUser.role}`);
    
    const sites = await prisma.site.findMany({ where: { userId: oldUser.id } });
    console.log(`  Sites: ${sites.length}`);
    for (const site of sites) {
      const conversations = await prisma.conversation.count({ where: { siteId: site.id } });
      const knowledge = await prisma.knowledgeEntry.count({ where: { siteId: site.id } });
      const contacts = await prisma.contact.count({ where: { siteId: site.id } });
      console.log(`    Site: ${site.name} (ID: ${site.id})`);
      console.log(`      Conversations: ${conversations}`);
      console.log(`      Knowledge: ${knowledge}`);
      console.log(`      Contacts: ${contacts}`);
    }
  } else {
    console.log("Old user not found");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
