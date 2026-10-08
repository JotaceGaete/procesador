import Workspace from "@/components/Workspace";
import LockProvider from "@/components/LockProvider";
import NovelGate from "@/components/NovelGate";

export default async function NovelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <LockProvider>
      <NovelGate novelId={id}>
        <Workspace novelId={id} />
      </NovelGate>
    </LockProvider>
  );
}
