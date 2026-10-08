import Library from "@/components/Library";
import LockProvider from "@/components/LockProvider";

export default function Home() {
  return (
    <LockProvider>
      <Library />
    </LockProvider>
  );
}
