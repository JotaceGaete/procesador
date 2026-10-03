import Workspace from "@/components/Workspace";

export default async function NovelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Workspace novelId={id} />;
}
