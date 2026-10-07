import Workspace from "@/components/Workspace";
import LockProvider from "@/components/LockProvider";

export default async function NovelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <LockProvider>
      <Workspace novelId={id} />
    </LockProvider>
  );
}
