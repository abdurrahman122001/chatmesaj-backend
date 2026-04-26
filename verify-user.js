import { prisma } from "./src/db.js";

async function verifyAdminEmail() {
  try {
    const user = await prisma.user.findFirst({
      where: {
        email: "qaziabdurrahman12@gmail.com"
      }
    });

    if (!user) {
      console.log("User not found. Searching all users:");
      const allUsers = await prisma.user.findMany();
      console.log(allUsers.map(u => ({ id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified })));
      process.exit(1);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        status: "APPROVED"
      }
    });

    console.log("✓ User verified successfully!");
    console.log("Email:", updated.email);
    console.log("Status:", updated.status);
    console.log("Email Verified:", updated.emailVerified);
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

verifyAdminEmail();
